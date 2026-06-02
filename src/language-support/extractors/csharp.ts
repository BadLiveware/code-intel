import type { ResultDetail } from "../../core/types.ts";
import type { ParsedFile, SymbolRecord, TreeSitterNode } from "../../tree-sitter/nodes.ts";
import { childForField, compactText, firstSourceLine, location, namedChildren, nodeText, simpleName } from "../../tree-sitter/nodes.ts";
import { callFunctionNode, selectorName } from "../../tree-sitter/syntax-shared.ts";

const TYPE_DECLARATIONS = new Set(["class_declaration", "record_declaration", "record_struct_declaration", "struct_declaration", "interface_declaration", "enum_declaration", "delegate_declaration"]);
const MEMBER_DECLARATIONS = new Set(["method_declaration", "constructor_declaration", "destructor_declaration", "operator_declaration", "conversion_operator_declaration", "property_declaration"]);

function snippetFields(parsed: ParsedFile, node: TreeSitterNode, detail: ResultDetail): Partial<SymbolRecord> {
	if (detail !== "snippets") return {};
	return { text: compactText(nodeText(parsed.source, node)), snippet: firstSourceLine(parsed, node) };
}

function headerText(parsed: ParsedFile, node: TreeSitterNode): string {
	const raw = nodeText(parsed.source, node);
	return compactText(raw.includes("{") ? raw.slice(0, raw.indexOf("{")) : raw.split(/\r?\n/)[0] ?? raw);
}

function isPublic(node: TreeSitterNode, source: string): boolean {
	return /\bpublic\b/.test(nodeText(source, node).slice(0, 160));
}

function nameOf(node: TreeSitterNode, source: string): string | undefined {
	const nameNode = childForField(node, "name") ?? namedChildren(node).find((child) => ["identifier", "qualified_name"].includes(child.type));
	return nameNode ? nodeText(source, nameNode) : undefined;
}

function typeSummary(node: TreeSitterNode, source: string): string | undefined {
	const typeNode = childForField(node, "type") ?? namedChildren(node).find((child) => ["predefined_type", "identifier", "qualified_name", "generic_name", "nullable_type"].includes(child.type));
	return typeNode ? nodeText(source, typeNode) : undefined;
}

function addDefinition(definitions: SymbolRecord[], parsed: ParsedFile, node: TreeSitterNode, name: string, kind = node.type, owner: string | undefined, detail: ResultDetail): void {
	definitions.push({
		kind,
		name,
		symbol: name,
		file: parsed.file,
		language: parsed.language,
		evidence: "tree-sitter:def",
		owner,
		type: typeSummary(node, parsed.source),
		exported: isPublic(node, parsed.source),
		...(detail === "snippets" ? { text: headerText(parsed, node) } : {}),
		...location(node),
	});
}

function variableDeclaratorNames(node: TreeSitterNode, source: string): string[] {
	const names: string[] = [];
	function visit(candidate: TreeSitterNode): void {
		if (candidate.type === "variable_declarator") {
			const nameNode = childForField(candidate, "name") ?? namedChildren(candidate).find((child) => child.type === "identifier");
			if (nameNode) names.push(nodeText(source, nameNode));
			return;
		}
		for (const child of namedChildren(candidate)) visit(child);
	}
	visit(node);
	return names;
}

function childContains(parent: TreeSitterNode, maybeChild: TreeSitterNode): boolean {
	return maybeChild.startIndex >= parent.startIndex && maybeChild.endIndex <= parent.endIndex;
}

function isInvocationFunctionPart(node: TreeSitterNode, parent: TreeSitterNode | undefined): boolean {
	if (parent?.type !== "invocation_expression") return false;
	const functionNode = callFunctionNode(parent);
	return functionNode ? childContains(functionNode, node) : false;
}

function initializerKey(node: TreeSitterNode, source: string): string | undefined {
	const left = childForField(node, "left") ?? node.namedChild(0);
	return left ? simpleName(nodeText(source, left).replace(/^['"]|['"]$/g, "")) : undefined;
}

export function extractCSharpFileRecords(parsed: ParsedFile, detail: ResultDetail): { definitions: SymbolRecord[]; candidates: SymbolRecord[] } {
	const definitions: SymbolRecord[] = [];
	const candidates: SymbolRecord[] = [];

	function visit(node: TreeSitterNode, currentFunction?: string, currentType?: string, parent?: TreeSitterNode): void {
		let nextFunction = currentFunction;
		let nextType = currentType;
		if (node.type === "namespace_declaration" || node.type === "file_scoped_namespace_declaration") {
			const name = nameOf(node, parsed.source);
			if (name) addDefinition(definitions, parsed, node, name, node.type, undefined, detail);
		} else if (TYPE_DECLARATIONS.has(node.type)) {
			const name = nameOf(node, parsed.source);
			if (name) {
				nextType = name;
				addDefinition(definitions, parsed, node, name, node.type, currentType, detail);
			}
		} else if (MEMBER_DECLARATIONS.has(node.type)) {
			const name = nameOf(node, parsed.source);
			if (name) {
				nextFunction = name;
				addDefinition(definitions, parsed, node, name, node.type, currentType, detail);
			}
		} else if (node.type === "field_declaration" || node.type === "event_field_declaration") {
			for (const name of variableDeclaratorNames(node, parsed.source)) addDefinition(definitions, parsed, node, name, node.type === "event_field_declaration" ? "event_declaration" : "field_declaration", currentType, detail);
		} else if (node.type === "enum_member_declaration") {
			const name = nameOf(node, parsed.source);
			if (name) addDefinition(definitions, parsed, node, name, "enum_member_declaration", currentType, detail);
		} else if (node.type === "invocation_expression") {
			const functionNode = callFunctionNode(node);
			const callee = functionNode ? nodeText(parsed.source, functionNode) : undefined;
			const name = simpleName(callee);
			if (name) candidates.push({ kind: "syntax_call", name, symbol: name, file: parsed.file, language: parsed.language, evidence: "tree-sitter:invocation_expression", inFunction: currentFunction, ...snippetFields(parsed, node, detail), ...location(node) });
		} else if (node.type === "member_access_expression" || node.type === "conditional_access_expression") {
			const name = selectorName(node, parsed.source);
			if (name && !isInvocationFunctionPart(node, parent)) candidates.push({ kind: "syntax_selector", name, symbol: name, file: parsed.file, language: parsed.language, evidence: `tree-sitter:${node.type}`, inFunction: currentFunction, ...snippetFields(parsed, node, detail), ...location(node) });
		} else if (node.type === "assignment_expression" && parent?.type === "initializer_expression") {
			const name = initializerKey(node, parsed.source);
			if (name) candidates.push({ kind: "syntax_keyed_field", name, symbol: name, file: parsed.file, language: parsed.language, evidence: "tree-sitter:assignment_expression", inFunction: currentFunction, ...snippetFields(parsed, node, detail), ...location(node) });
		}

		for (const child of namedChildren(node)) visit(child, nextFunction, nextType, node);
	}

	visit(parsed.root);
	return { definitions, candidates };
}

import type { ResultDetail } from "../../core/types.ts";
import type { ParsedFile, SymbolRecord, TreeSitterNode } from "../../tree-sitter/nodes.ts";
import { childForField, compactText, firstSourceLine, location, namedChildren, nodeText, simpleName } from "../../tree-sitter/nodes.ts";
import { callFunctionNode, keyedName, selectorName } from "../../tree-sitter/syntax-shared.ts";

function snippetFields(parsed: ParsedFile, node: TreeSitterNode, detail: ResultDetail): Partial<SymbolRecord> {
	if (detail !== "snippets") return {};
	return { text: compactText(nodeText(parsed.source, node)), snippet: firstSourceLine(parsed, node) };
}

function headerText(parsed: ParsedFile, node: TreeSitterNode): string {
	const raw = nodeText(parsed.source, node);
	return compactText(raw.includes("{") ? raw.slice(0, raw.indexOf("{")) : raw.split(/\r?\n/)[0] ?? raw);
}

function nameOf(node: TreeSitterNode, source: string): string | undefined {
	const nameNode = childForField(node, "name") ?? namedChildren(node).find((child) => ["identifier", "field_identifier", "type_identifier"].includes(child.type));
	return nameNode ? nodeText(source, nameNode) : undefined;
}

function typeSummary(node: TreeSitterNode, source: string): string | undefined {
	const typeNode = childForField(node, "type");
	return typeNode ? nodeText(source, typeNode) : undefined;
}

function receiverOwner(node: TreeSitterNode, source: string): string | undefined {
	const receiver = namedChildren(node).find((child) => child.type === "parameter_list");
	if (!receiver) return undefined;
	const raw = nodeText(source, receiver);
	const match = /(?:\*|\s|\.)([A-Za-z_]\w*)\s*\)$/.exec(raw);
	return match ? simpleName(match[1]) : undefined;
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
		exported: /^[A-Z]/.test(name),
		...(detail === "snippets" ? { text: headerText(parsed, node) } : {}),
		...location(node),
	});
}

function childContains(parent: TreeSitterNode, maybeChild: TreeSitterNode): boolean {
	return maybeChild.startIndex >= parent.startIndex && maybeChild.endIndex <= parent.endIndex;
}

function isCallFunctionPart(node: TreeSitterNode, parent: TreeSitterNode | undefined): boolean {
	if (parent?.type !== "call_expression") return false;
	const functionNode = callFunctionNode(parent);
	return functionNode ? childContains(functionNode, node) : false;
}

export function extractGoFileRecords(parsed: ParsedFile, detail: ResultDetail): { definitions: SymbolRecord[]; candidates: SymbolRecord[] } {
	const definitions: SymbolRecord[] = [];
	const candidates: SymbolRecord[] = [];

	function visit(node: TreeSitterNode, currentFunction?: string, currentType?: string, parent?: TreeSitterNode): void {
		let nextFunction = currentFunction;
		let nextType = currentType;
		if (node.type === "function_declaration") {
			const name = nameOf(node, parsed.source);
			if (name) {
				nextFunction = name;
				addDefinition(definitions, parsed, node, name, node.type, undefined, detail);
			}
		} else if (node.type === "method_declaration") {
			const name = nameOf(node, parsed.source);
			if (name) {
				nextFunction = name;
				addDefinition(definitions, parsed, node, name, node.type, receiverOwner(node, parsed.source) ?? currentType, detail);
			}
		} else if (node.type === "type_spec" || node.type === "type_alias") {
			const name = nameOf(node, parsed.source);
			if (name) {
				nextType = name;
				addDefinition(definitions, parsed, node, name, node.type === "type_spec" ? "type" : "type_alias", undefined, detail);
			}
		} else if (node.type === "method_elem") {
			const name = nameOf(node, parsed.source);
			if (name) addDefinition(definitions, parsed, node, name, "method_signature", currentType, detail);
		} else if (node.type === "const_spec" || node.type === "var_spec") {
			const name = nameOf(node, parsed.source);
			if (name && !currentFunction) addDefinition(definitions, parsed, node, name, node.type === "const_spec" ? "constant_declaration" : "variable_declaration", currentType, detail);
		} else if (node.type === "field_declaration") {
			const name = nameOf(node, parsed.source);
			if (name) addDefinition(definitions, parsed, node, name, "field_declaration", currentType, detail);
		} else if (node.type === "call_expression") {
			const functionNode = callFunctionNode(node);
			const callee = functionNode ? nodeText(parsed.source, functionNode) : undefined;
			const name = simpleName(callee);
			if (name) candidates.push({ kind: "syntax_call", name, symbol: name, file: parsed.file, language: parsed.language, evidence: "tree-sitter:call_expression", inFunction: currentFunction, ...snippetFields(parsed, node, detail), ...location(node) });
		} else if (node.type === "selector_expression") {
			const name = selectorName(node, parsed.source);
			if (name && !isCallFunctionPart(node, parent)) candidates.push({ kind: "syntax_selector", name, symbol: name, file: parsed.file, language: parsed.language, evidence: "tree-sitter:selector_expression", inFunction: currentFunction, ...snippetFields(parsed, node, detail), ...location(node) });
		} else if (node.type === "keyed_element") {
			const name = keyedName(node, parsed.source);
			if (name) candidates.push({ kind: "syntax_keyed_field", name, symbol: name, file: parsed.file, language: parsed.language, evidence: "tree-sitter:keyed_element", inFunction: currentFunction, ...snippetFields(parsed, node, detail), ...location(node) });
		}

		for (const child of namedChildren(node)) visit(child, nextFunction, nextType, node);
	}

	visit(parsed.root);
	return { definitions, candidates };
}

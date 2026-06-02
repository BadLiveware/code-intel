import type { ResultDetail } from "./types.ts";
import type { ParsedFile, SymbolRecord, TreeSitterNode } from "./tree-sitter/nodes.ts";

function nodeText(source: string, node: TreeSitterNode): string {
	return source.slice(node.startIndex, node.endIndex);
}

function namedChildren(node: TreeSitterNode): TreeSitterNode[] {
	const children: TreeSitterNode[] = [];
	for (let index = 0; index < node.namedChildCount; index++) {
		const child = node.namedChild(index);
		if (child) children.push(child);
	}
	return children;
}

function childForField(node: TreeSitterNode, name: string): TreeSitterNode | null {
	try {
		return node.childForFieldName?.(name) ?? null;
	} catch {
		return null;
	}
}

function compactText(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function firstSourceLine(parsed: ParsedFile, node: TreeSitterNode): string {
	parsed.sourceLines ??= parsed.source.split(/\r?\n/);
	const line = parsed.sourceLines[node.startPosition.row] ?? nodeText(parsed.source, node);
	return line.trimEnd();
}

function location(node: TreeSitterNode): Pick<SymbolRecord, "line" | "column" | "endLine" | "endColumn"> {
	return {
		line: node.startPosition.row + 1,
		column: node.startPosition.column + 1,
		endLine: node.endPosition.row + 1,
		endColumn: node.endPosition.column + 1,
	};
}

function simpleName(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const trimmed = value.trim();
	const parts = trimmed.split(/\.|::/);
	return parts.at(-1) || trimmed;
}

function definitionName(node: TreeSitterNode, source: string): string | undefined {
	const nameNode = childForField(node, "name") ?? namedChildren(node).find((child) => ["identifier", "type_identifier", "field_identifier"].includes(child.type));
	return nameNode ? nodeText(source, nameNode) : undefined;
}

function typeSummary(node: TreeSitterNode, source: string): string | undefined {
	const typeNode = childForField(node, "type") ?? childForField(node, "value");
	return typeNode ? nodeText(source, typeNode) : undefined;
}

function fieldTypeSummary(node: TreeSitterNode, source: string): string | undefined {
	const fieldType = childForField(node, "type");
	if (fieldType) return nodeText(source, fieldType);
	const typeNode = namedChildren(node).find((child) => !["visibility_modifier", "field_identifier", "identifier", "tag"].includes(child.type));
	return typeNode ? nodeText(source, typeNode) : undefined;
}

function functionHeader(node: TreeSitterNode, source: string): string {
	const raw = nodeText(source, node);
	return compactText(raw.includes("{") ? raw.slice(0, raw.indexOf("{")) : raw.split(/\r?\n/)[0] ?? raw);
}

function isPublicRust(node: TreeSitterNode, source: string): boolean {
	return /\bpub(?:\s*\([^)]*\))?\b/.test(nodeText(source, node).slice(0, 120));
}

function callFunctionNode(node: TreeSitterNode): TreeSitterNode | null {
	return childForField(node, "function") ?? node.namedChild(0);
}

function childContains(parent: TreeSitterNode, maybeChild: TreeSitterNode): boolean {
	return maybeChild.startIndex >= parent.startIndex && maybeChild.endIndex <= parent.endIndex;
}

function isCallFunctionPart(node: TreeSitterNode, callNode: TreeSitterNode): boolean {
	const functionNode = callFunctionNode(callNode);
	return functionNode ? childContains(functionNode, node) : false;
}

function selectorName(node: TreeSitterNode, source: string): string | undefined {
	const fieldNode = childForField(node, "field") ?? node.namedChild(1);
	return fieldNode ? simpleName(nodeText(source, fieldNode)) : undefined;
}

function selectorObject(node: TreeSitterNode): TreeSitterNode | undefined {
	return childForField(node, "operand") ?? childForField(node, "object") ?? node.namedChild(0) ?? undefined;
}

function fieldInitializerName(node: TreeSitterNode, source: string): string | undefined {
	const keyNode = childForField(node, "field") ?? childForField(node, "name") ?? node.namedChild(0);
	return keyNode ? nodeText(source, keyNode) : undefined;
}

function rustImplOwner(node: TreeSitterNode, source: string): string | undefined {
	const candidates = namedChildren(node).filter((child) => ["type_identifier", "scoped_type_identifier", "generic_type", "qualified_type", "identifier"].includes(child.type));
	const target = candidates.at(-1);
	return target ? simpleName(nodeText(source, target)) : undefined;
}

function snippetFields(parsed: ParsedFile, node: TreeSitterNode, detail: ResultDetail): Partial<SymbolRecord> {
	if (detail !== "snippets") return {};
	return { text: compactText(nodeText(parsed.source, node)), snippet: firstSourceLine(parsed, node) };
}

function addDefinition(definitions: SymbolRecord[], parsed: ParsedFile, node: TreeSitterNode, name: string, kind = node.type, owner?: string, detail: ResultDetail = "locations"): void {
	definitions.push({
		kind,
		name,
		symbol: name,
		file: parsed.file,
		language: parsed.language,
		evidence: "tree-sitter:def",
		owner,
		type: typeSummary(node, parsed.source),
		exported: isPublicRust(node, parsed.source),
		...(detail === "snippets" ? { text: functionHeader(node, parsed.source) } : {}),
		...location(node),
	});
}

export function extractRustFileRecords(parsed: ParsedFile, detail: ResultDetail): { definitions: SymbolRecord[]; candidates: SymbolRecord[] } {
	const definitions: SymbolRecord[] = [];
	const candidates: SymbolRecord[] = [];

	function visit(node: TreeSitterNode, currentFunction?: string, currentType?: string, parent?: TreeSitterNode): void {
		let nextFunction = currentFunction;
		let nextType = currentType;
		if (["function_item", "function_signature_item"].includes(node.type)) {
			const name = definitionName(node, parsed.source);
			if (name) {
				nextFunction = name;
				addDefinition(definitions, parsed, node, name, node.type, currentType, detail);
			}
		} else if (["struct_item", "enum_item", "trait_item", "type_item", "mod_item", "const_item", "static_item", "macro_definition"].includes(node.type)) {
			const name = definitionName(node, parsed.source);
			if (name) {
				nextType = name;
				addDefinition(definitions, parsed, node, name, node.type, undefined, detail);
			}
		} else if (node.type === "impl_item") {
			nextType = rustImplOwner(node, parsed.source) ?? currentType;
		} else if (node.type === "field_declaration") {
			const name = definitionName(node, parsed.source);
			if (name) definitions.push({ kind: "field_declaration", name, symbol: name, owner: currentType, file: parsed.file, language: parsed.language, evidence: "tree-sitter:field_declaration", type: fieldTypeSummary(node, parsed.source), exported: isPublicRust(node, parsed.source), ...(detail === "snippets" ? { text: compactText(nodeText(parsed.source, node)) } : {}), ...location(node) });
		} else if (node.type === "call_expression") {
			const functionNode = callFunctionNode(node);
			const callee = functionNode ? nodeText(parsed.source, functionNode) : undefined;
			const name = simpleName(callee);
			if (name) candidates.push({ kind: "syntax_call", name, symbol: name, file: parsed.file, language: parsed.language, evidence: "tree-sitter:call_expression", inFunction: currentFunction, ...snippetFields(parsed, node, detail), ...location(node) });
		} else if (node.type === "macro_invocation") {
			const name = definitionName(node, parsed.source);
			if (name) candidates.push({ kind: "syntax_call", name, symbol: name, file: parsed.file, language: parsed.language, evidence: "tree-sitter:macro_invocation", inFunction: currentFunction, ...snippetFields(parsed, node, detail), ...location(node) });
		} else if (node.type === "field_expression" || node.type === "scoped_identifier") {
			const name = selectorName(node, parsed.source);
			if (name && !(parent?.type === "call_expression" && isCallFunctionPart(node, parent))) candidates.push({ kind: "syntax_selector", name, symbol: name, file: parsed.file, language: parsed.language, evidence: `tree-sitter:${node.type}`, inFunction: currentFunction, ...snippetFields(parsed, node, detail), ...location(node) });
		} else if (node.type === "field_initializer" || node.type === "shorthand_field_initializer") {
			const name = fieldInitializerName(node, parsed.source);
			if (name) candidates.push({ kind: "syntax_keyed_field", name, symbol: name, file: parsed.file, language: parsed.language, evidence: `tree-sitter:${node.type}`, inFunction: currentFunction, ...snippetFields(parsed, node, detail), ...location(node) });
		}

		for (const child of namedChildren(node)) visit(child, nextFunction, nextType, node);
	}

	visit(parsed.root);
	return { definitions, candidates };
}

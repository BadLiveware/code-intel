import type { ResultDetail } from "../../core/types.ts";
import type { ParsedFile, SymbolRecord, TreeSitterNode } from "../../tree-sitter/nodes.ts";
import { childForField, compactText, firstSourceLine, location, namedChildren, nodeText, simpleName } from "../../tree-sitter/nodes.ts";

function snippetFields(parsed: ParsedFile, node: TreeSitterNode, detail: ResultDetail): Partial<SymbolRecord> {
	if (detail !== "snippets") return {};
	return { text: compactText(nodeText(parsed.source, node)), snippet: firstSourceLine(parsed, node) };
}

function headerText(parsed: ParsedFile, node: TreeSitterNode): string {
	return compactText(nodeText(parsed.source, node).split(/\r?\n/)[0] ?? nodeText(parsed.source, node));
}

function nameOf(node: TreeSitterNode, source: string): string | undefined {
	const nameNode = childForField(node, "name") ?? namedChildren(node).find((child) => child.type === "identifier");
	return nameNode ? nodeText(source, nameNode) : undefined;
}

function assignmentName(node: TreeSitterNode, source: string): string | undefined {
	const left = childForField(node, "left") ?? node.namedChild(0);
	return left ? simpleName(nodeText(source, left).replace(/^['"]|['"]$/g, "")) : undefined;
}

function typeSummary(node: TreeSitterNode, source: string): string | undefined {
	const typeNode = childForField(node, "type") ?? namedChildren(node).find((child) => child.type === "type");
	return typeNode ? nodeText(source, typeNode) : undefined;
}

function addDefinition(definitions: SymbolRecord[], parsed: ParsedFile, node: TreeSitterNode, name: string, kind = node.type, owner: string | undefined, detail: ResultDetail): void {
	definitions.push({ kind, name, symbol: name, file: parsed.file, language: parsed.language, evidence: "tree-sitter:def", owner, type: typeSummary(node, parsed.source), exported: !name.startsWith("_"), ...(detail === "snippets" ? { text: headerText(parsed, node) } : {}), ...location(node) });
}

function decoratedChild(node: TreeSitterNode): TreeSitterNode | undefined {
	return namedChildren(node).find((child) => child.type === "function_definition" || child.type === "class_definition");
}

function callName(node: TreeSitterNode, source: string): string | undefined {
	const functionNode = childForField(node, "function") ?? node.namedChild(0);
	return functionNode ? simpleName(nodeText(source, functionNode)) : undefined;
}

function attributeName(node: TreeSitterNode, source: string): string | undefined {
	const attr = childForField(node, "attribute") ?? node.namedChild(1);
	return attr ? nodeText(source, attr) : undefined;
}

function pairKey(node: TreeSitterNode, source: string): string | undefined {
	const key = childForField(node, "key") ?? node.namedChild(0);
	return key ? nodeText(source, key).replace(/^['"]|['"]$/g, "") : undefined;
}

export function extractPythonFileRecords(parsed: ParsedFile, detail: ResultDetail): { definitions: SymbolRecord[]; candidates: SymbolRecord[] } {
	const definitions: SymbolRecord[] = [];
	const candidates: SymbolRecord[] = [];

	function visit(node: TreeSitterNode, currentFunction?: string, currentType?: string, parent?: TreeSitterNode): void {
		let nextFunction = currentFunction;
		let nextType = currentType;
		if (node.type === "decorated_definition") {
			const child = decoratedChild(node);
			const name = child ? nameOf(child, parsed.source) : undefined;
			if (child && name) addDefinition(definitions, parsed, node, name, child.type, currentType, detail);
		} else if (node.type === "class_definition") {
			const name = nameOf(node, parsed.source);
			if (name) {
				nextType = name;
				if (parent?.type !== "decorated_definition") addDefinition(definitions, parsed, node, name, node.type, currentType, detail);
			}
		} else if (node.type === "function_definition") {
			const name = nameOf(node, parsed.source);
			if (name) {
				nextFunction = name;
				if (parent?.type !== "decorated_definition") addDefinition(definitions, parsed, node, name, node.type, currentType, detail);
			}
		} else if (node.type === "assignment" && !currentFunction) {
			const name = assignmentName(node, parsed.source);
			if (name) addDefinition(definitions, parsed, node, name, currentType ? "field_declaration" : "variable_declaration", currentType, detail);
		} else if (node.type === "call") {
			const name = callName(node, parsed.source);
			if (name) candidates.push({ kind: "syntax_call", name, symbol: name, file: parsed.file, language: parsed.language, evidence: "tree-sitter:call", inFunction: currentFunction, ...snippetFields(parsed, node, detail), ...location(node) });
		} else if (node.type === "attribute") {
			const name = attributeName(node, parsed.source);
			if (name && parent?.type !== "call") candidates.push({ kind: "syntax_selector", name, symbol: name, file: parsed.file, language: parsed.language, evidence: "tree-sitter:attribute", inFunction: currentFunction, ...snippetFields(parsed, node, detail), ...location(node) });
		} else if (node.type === "keyword_argument") {
			const name = nameOf(node, parsed.source);
			if (name) candidates.push({ kind: "syntax_keyed_field", name, symbol: name, file: parsed.file, language: parsed.language, evidence: "tree-sitter:keyword_argument", inFunction: currentFunction, ...snippetFields(parsed, node, detail), ...location(node) });
		} else if (node.type === "pair") {
			const name = pairKey(node, parsed.source);
			if (name) candidates.push({ kind: "syntax_keyed_field", name, symbol: name, file: parsed.file, language: parsed.language, evidence: "tree-sitter:pair", inFunction: currentFunction, ...snippetFields(parsed, node, detail), ...location(node) });
		}

		for (const child of namedChildren(node)) visit(child, nextFunction, nextType, node);
	}

	visit(parsed.root);
	return { definitions, candidates };
}

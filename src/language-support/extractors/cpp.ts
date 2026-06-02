import type { ResultDetail } from "../../core/types.ts";
import type { ParsedFile, SymbolRecord, TreeSitterNode } from "../../tree-sitter/nodes.ts";
import { childForField, compactText, firstSourceLine, location, namedChildren, nodeText, simpleName } from "../../tree-sitter/nodes.ts";
import { extractGenericFileRecords } from "./generic.ts";

function snippet(parsed: ParsedFile, node: TreeSitterNode, detail: ResultDetail): Partial<SymbolRecord> {
	if (detail !== "snippets") return {};
	return { text: compactText(nodeText(parsed.source, node).split("{")[0] ?? nodeText(parsed.source, node)), snippet: firstSourceLine(parsed, node) };
}

function nameOf(node: TreeSitterNode, source: string): string | undefined {
	const nameNode = childForField(node, "name") ?? namedChildren(node).find((child) => ["identifier", "type_identifier", "namespace_identifier", "field_identifier", "qualified_identifier", "destructor_name"].includes(child.type));
	if (!nameNode) return undefined;
	return simpleName(nodeText(source, nameNode).replace(/^~/, ""));
}

function qualifiedOwner(node: TreeSitterNode, source: string): string | undefined {
	const declarator = childForField(node, "declarator");
	const qualified = declarator ? namedChildren(declarator).find((child) => child.type === "qualified_identifier") : undefined;
	if (!qualified) return undefined;
	const text = nodeText(source, qualified);
	const parts = text.split("::").filter(Boolean);
	return parts.length > 1 ? parts.at(-2)?.replace(/^~/, "") : undefined;
}

function functionDeclaratorName(node: TreeSitterNode, source: string): string | undefined {
	const declarator = childForField(node, "declarator") ?? namedChildren(node).find((child) => child.type === "function_declarator");
	if (!declarator) return undefined;
	const nameNode = childForField(declarator, "declarator") ?? namedChildren(declarator).find((child) => ["identifier", "field_identifier", "qualified_identifier", "destructor_name"].includes(child.type));
	return nameNode ? simpleName(nodeText(source, nameNode).replace(/^~/, "")) : undefined;
}

function add(definitions: SymbolRecord[], parsed: ParsedFile, node: TreeSitterNode, name: string, kind: string, owner: string | undefined, detail: ResultDetail, type?: string): void {
	definitions.push({ kind, name, symbol: name, file: parsed.file, language: parsed.language, evidence: `tree-sitter:${kind}`, owner, type, exported: true, ...snippet(parsed, node, detail), ...location(node) });
}

export function extractCppFileRecords(parsed: ParsedFile, detail: ResultDetail): { definitions: SymbolRecord[]; candidates: SymbolRecord[] } {
	const records = extractGenericFileRecords(parsed, detail);

	function visit(node: TreeSitterNode, currentType?: string): void {
		let nextType = currentType;
		if (node.type === "namespace_definition") {
			const name = nameOf(node, parsed.source);
			if (name) add(records.definitions, parsed, node, name, "namespace_definition", undefined, detail);
		} else if (node.type === "preproc_def" || node.type === "preproc_function_def") {
			const name = nameOf(node, parsed.source);
			if (name) add(records.definitions, parsed, node, name, "macro_definition", currentType, detail);
		} else if (node.type === "class_specifier" || node.type === "struct_specifier" || node.type === "enum_specifier") {
			const name = nameOf(node, parsed.source);
			if (name) nextType = name;
		} else if (node.type === "declaration" || node.type === "field_declaration") {
			const name = functionDeclaratorName(node, parsed.source);
			if (name) add(records.definitions, parsed, node, name, "method_declaration", currentType, detail);
		} else if (node.type === "function_definition") {
			const name = functionDeclaratorName(node, parsed.source);
			const owner = qualifiedOwner(node, parsed.source) ?? currentType;
			if (name && owner) add(records.definitions, parsed, node, name, "method_definition", owner, detail);
		} else if (node.type === "template_declaration") {
			const fn = namedChildren(node).find((child) => child.type === "function_definition" || child.type === "declaration");
			const name = fn ? functionDeclaratorName(fn, parsed.source) : undefined;
			if (fn && name) add(records.definitions, parsed, node, name, "template_declaration", currentType, detail);
		}
		for (const child of namedChildren(node)) visit(child, nextType);
	}

	visit(parsed.root);
	return records;
}

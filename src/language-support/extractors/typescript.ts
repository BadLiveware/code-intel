import type { ResultDetail } from "../../core/types.ts";
import type { ParsedFile, SymbolRecord, TreeSitterNode } from "../../tree-sitter/nodes.ts";
import { childForField, compactText, firstSourceLine, location, namedChildren, nodeText, simpleName } from "../../tree-sitter/nodes.ts";
import { extractGenericFileRecords } from "./generic.ts";

function snippetFields(parsed: ParsedFile, node: TreeSitterNode, detail: ResultDetail): Partial<SymbolRecord> {
	if (detail !== "snippets") return {};
	return { text: compactText(nodeText(parsed.source, node)), snippet: firstSourceLine(parsed, node) };
}

function jsxName(node: TreeSitterNode, source: string): string | undefined {
	const nameNode = childForField(node, "name") ?? namedChildren(node).find((child) => ["identifier", "member_expression", "nested_identifier"].includes(child.type));
	return nameNode ? simpleName(nodeText(source, nameNode)) : undefined;
}

function newExpressionName(node: TreeSitterNode, source: string): string | undefined {
	const constructorNode = childForField(node, "constructor") ?? namedChildren(node).find((child) => !["arguments", "type_arguments"].includes(child.type));
	return constructorNode ? simpleName(nodeText(source, constructorNode)) : undefined;
}

export function extractTypeScriptFileRecords(parsed: ParsedFile, detail: ResultDetail): { definitions: SymbolRecord[]; candidates: SymbolRecord[] } {
	const records = extractGenericFileRecords(parsed, detail);

	function visit(node: TreeSitterNode, currentFunction?: string): void {
		let nextFunction = currentFunction;
		if (["function_declaration", "method_definition"].includes(node.type)) {
			const nameNode = childForField(node, "name");
			if (nameNode) nextFunction = nodeText(parsed.source, nameNode);
		}
		if (node.type === "new_expression") {
			const name = newExpressionName(node, parsed.source);
			if (name) records.candidates.push({ kind: "syntax_call", name, symbol: name, file: parsed.file, language: parsed.language, evidence: "tree-sitter:new_expression", inFunction: currentFunction, ...snippetFields(parsed, node, detail), ...location(node) });
		} else if (node.type === "jsx_opening_element" || node.type === "jsx_self_closing_element") {
			const name = jsxName(node, parsed.source);
			if (name && /^[A-Z]/.test(name)) records.candidates.push({ kind: "syntax_call", name, symbol: name, file: parsed.file, language: parsed.language, evidence: `tree-sitter:${node.type}`, inFunction: currentFunction, ...snippetFields(parsed, node, detail), ...location(node) });
		}
		for (const child of namedChildren(node)) visit(child, nextFunction);
	}

	visit(parsed.root);
	return records;
}

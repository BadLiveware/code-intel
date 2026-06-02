import type { ResultDetail } from "../../core/types.ts";
import type { ParsedFile, SymbolRecord, TreeSitterNode } from "../../tree-sitter/nodes.ts";
import { childForField, compactText, firstSourceLine, location, namedChildren, nodeText } from "../../tree-sitter/nodes.ts";

function snippetFields(parsed: ParsedFile, node: TreeSitterNode, detail: ResultDetail): Partial<SymbolRecord> {
	if (detail !== "snippets") return {};
	return { text: compactText(nodeText(parsed.source, node)), snippet: firstSourceLine(parsed, node) };
}

function addDefinition(definitions: SymbolRecord[], parsed: ParsedFile, node: TreeSitterNode, name: string, kind: string, detail: ResultDetail): void {
	definitions.push({ kind, name, symbol: name, file: parsed.file, language: parsed.language, evidence: `tree-sitter:${kind}`, exported: false, ...(detail === "snippets" ? { text: compactText(nodeText(parsed.source, node)) } : {}), ...location(node) });
}

function commandName(node: TreeSitterNode, source: string): string | undefined {
	const nameNode = childForField(node, "name") ?? namedChildren(node).find((child) => child.type === "command_name")?.namedChild(0) ?? namedChildren(node).find((child) => child.type === "word");
	return nameNode ? nodeText(source, nameNode) : undefined;
}

function variableName(node: TreeSitterNode, source: string): string | undefined {
	const nameNode = childForField(node, "name") ?? namedChildren(node).find((child) => child.type === "variable_name");
	return nameNode ? nodeText(source, nameNode) : undefined;
}

function aliasName(node: TreeSitterNode, source: string): string | undefined {
	const text = nodeText(source, node);
	const match = /^alias\s+([A-Za-z_][\w-]*)=/.exec(text.trim());
	return match?.[1];
}

function trapName(node: TreeSitterNode, source: string): string | undefined {
	const text = nodeText(source, node).trim();
	if (!text.startsWith("trap ")) return undefined;
	return text.split(/\s+/).at(-1);
}

function isTopLevel(parent: TreeSitterNode | undefined): boolean {
	return parent?.type === "program";
}

export function extractShellFileRecords(parsed: ParsedFile, detail: ResultDetail): { definitions: SymbolRecord[]; candidates: SymbolRecord[] } {
	const definitions: SymbolRecord[] = [];
	const candidates: SymbolRecord[] = [];

	function visit(node: TreeSitterNode, currentFunction?: string, parent?: TreeSitterNode): void {
		let nextFunction = currentFunction;
		if (node.type === "function_definition") {
			const name = commandName(node, parsed.source);
			if (name) {
				nextFunction = name;
				addDefinition(definitions, parsed, node, name, "function_definition", detail);
			}
		} else if (node.type === "variable_assignment" && isTopLevel(parent)) {
			const name = variableName(node, parsed.source);
			if (name) addDefinition(definitions, parsed, node, name, "variable_declaration", detail);
		} else if (node.type === "command") {
			const name = commandName(node, parsed.source);
			if (name === "alias" && isTopLevel(parent)) {
				const alias = aliasName(node, parsed.source);
				if (alias) addDefinition(definitions, parsed, node, alias, "alias_declaration", detail);
			} else if (name === "trap" && isTopLevel(parent)) {
				const signal = trapName(node, parsed.source);
				if (signal) addDefinition(definitions, parsed, node, signal, "trap_declaration", detail);
			}
			if (name) candidates.push({ kind: "syntax_call", name, symbol: name, file: parsed.file, language: parsed.language, evidence: "tree-sitter:command", inFunction: currentFunction, ...snippetFields(parsed, node, detail), ...location(node) });
			if ((name === "source" || name === "." || name === "autoload") && namedChildren(node).length > 1) {
				const target = nodeText(parsed.source, namedChildren(node).at(-1) as TreeSitterNode);
				candidates.push({ kind: "syntax_keyed_field", name: target, symbol: target, file: parsed.file, language: parsed.language, evidence: `tree-sitter:${name === "autoload" ? "autoload" : "source"}`, inFunction: currentFunction, ...snippetFields(parsed, node, detail), ...location(node) });
			}
		}

		for (const child of namedChildren(node)) visit(child, nextFunction, node);
	}

	visit(parsed.root);
	return { definitions, candidates };
}

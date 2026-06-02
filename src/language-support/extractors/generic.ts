import type { ResultDetail } from "../../types.ts";
import type { ParsedFile, SymbolRecord, TreeSitterNode } from "../../tree-sitter/nodes.ts";
import { childForField, compactText, firstSourceLine, location, namedChildren, nodeText, simpleName } from "../../tree-sitter/nodes.ts";

function rightmostNamedNode(node: TreeSitterNode, types: Set<string>): TreeSitterNode | undefined {
	if (types.has(node.type)) return node;
	const children = namedChildren(node);
	for (let index = children.length - 1; index >= 0; index--) {
		const match = rightmostNamedNode(children[index], types);
		if (match) return match;
	}
	return undefined;
}

function functionLikeNameFromHeader(node: TreeSitterNode, source: string): string | undefined {
	const raw = nodeText(source, node);
	const header = (raw.includes("{") ? raw.slice(0, raw.indexOf("{")) : raw).split("(")[0]?.trim();
	if (!header) return undefined;
	const match = /(?:~?[A-Za-z_]\w*|operator\s*[^\s(]+)(?=\s*$)/.exec(header);
	if (!match) return undefined;
	const text = match[0].replace(/^~/, "").trim();
	return text.includes("::") ? text.split("::").filter(Boolean).at(-1) : text;
}

function definitionName(node: TreeSitterNode, source: string): string | undefined {
	const nameNode = childForField(node, "name");
	if (nameNode) return nodeText(source, nameNode);
	if (["function_definition", "function_declaration", "method_declaration", "method_definition"].includes(node.type)) {
		const headerName = functionLikeNameFromHeader(node, source);
		if (headerName) return headerName;
	}
	const declarator = childForField(node, "declarator");
	const fallback = declarator ? rightmostNamedNode(declarator, new Set(["identifier", "field_identifier", "qualified_identifier", "operator_name", "destructor_name"])) : undefined;
	if (!fallback) return undefined;
	const text = nodeText(source, fallback);
	return text.includes("::") ? text.split("::").filter(Boolean).at(-1) : text;
}

function typeSummary(node: TreeSitterNode, source: string): string | undefined {
	const typeNode = childForField(node, "type") ?? childForField(node, "value");
	if (!typeNode) return undefined;
	return nodeText(source, typeNode).split(/\s|\{/)[0];
}

function functionHeader(node: TreeSitterNode, source: string, name: string): string {
	const raw = nodeText(source, node);
	return compactText(raw.includes("{") ? raw.slice(0, raw.indexOf("{")) : raw.split(/\r?\n/)[0] ?? name);
}

function isExportedDefinition(node: TreeSitterNode, source: string, name: string): boolean {
	if (/^[A-Z]/.test(name)) return true;
	const prefix = source.slice(Math.max(0, node.startIndex - 48), node.startIndex);
	return /\bexport\s+(?:default\s+)?$/.test(prefix);
}

function callFunctionNode(node: TreeSitterNode): TreeSitterNode | null {
	return childForField(node, "function") ?? node.namedChild(0);
}

function selectorName(node: TreeSitterNode, source: string): string | undefined {
	const fieldNode = childForField(node, "field") ?? childForField(node, "property") ?? childForField(node, "attribute") ?? node.namedChild(1);
	return fieldNode ? nodeText(source, fieldNode) : undefined;
}

function childContains(parent: TreeSitterNode, maybeChild: TreeSitterNode): boolean {
	return maybeChild.startIndex >= parent.startIndex && maybeChild.endIndex <= parent.endIndex;
}

function isCallFunctionPart(node: TreeSitterNode, callNode: TreeSitterNode): boolean {
	const functionNode = callFunctionNode(callNode);
	return functionNode ? childContains(functionNode, node) : false;
}

function keyedName(node: TreeSitterNode, source: string): string | undefined {
	const keyNode = childForField(node, "key") ?? childForField(node, "name") ?? childForField(node, "field") ?? node.namedChild(0);
	return keyNode ? nodeText(source, keyNode).replace(/^['"]|['"]$/g, "") : undefined;
}

export function extractGenericFileRecords(parsed: ParsedFile, detail: ResultDetail): { definitions: SymbolRecord[]; candidates: SymbolRecord[] } {
	const definitions: SymbolRecord[] = [];
	const candidates: SymbolRecord[] = [];
	const includeSnippets = detail === "snippets";

	function snippetFields(node: TreeSitterNode): Partial<SymbolRecord> {
		if (!includeSnippets) return {};
		return { text: compactText(nodeText(parsed.source, node)), snippet: firstSourceLine(parsed, node) };
	}

	function addDefinition(node: TreeSitterNode, name: string, kind = node.type, currentType?: string): void {
		definitions.push({ kind, name, symbol: name, file: parsed.file, language: parsed.language, evidence: "tree-sitter:def", owner: currentType, type: typeSummary(node, parsed.source), exported: isExportedDefinition(node, parsed.source, name), ...(includeSnippets ? { text: functionHeader(node, parsed.source, name) } : {}), ...location(node) });
	}

	function visit(node: TreeSitterNode, currentFunction?: string, currentType?: string, parent?: TreeSitterNode): void {
		let nextFunction = currentFunction;
		let nextType = currentType;
		if (["function_declaration", "function_definition", "method_declaration", "method_definition"].includes(node.type)) {
			const name = definitionName(node, parsed.source);
			if (name) {
				nextFunction = name;
				const objectLiteralMethod = node.type === "method_definition" && !currentType;
				if (!objectLiteralMethod) addDefinition(node, name, node.type, currentType);
			}
		} else if (["class_declaration", "class_definition", "class_specifier", "struct_specifier", "enum_specifier", "interface_declaration", "type_alias_declaration", "type_spec"].includes(node.type)) {
			const name = definitionName(node, parsed.source);
			if (name) {
				nextType = name;
				addDefinition(node, name, node.type === "type_spec" ? "type" : node.type);
			}
		} else if (node.type === "variable_declarator") {
			const nameNode = childForField(node, "name");
			const valueNode = childForField(node, "value");
			const name = nameNode ? nodeText(parsed.source, nameNode) : undefined;
			if (name && valueNode && ["arrow_function", "function", "function_expression"].includes(valueNode.type)) {
				nextFunction = name;
				addDefinition(node, name, "function_variable");
			} else if (name && !currentFunction) {
				const prefix = parsed.source.slice(Math.max(0, node.startIndex - 48), node.startIndex);
				addDefinition(node, name, /\bconst\s+$/.test(prefix) ? "constant_declaration" : "variable_declarator", currentType);
			}
		} else if (["const_spec", "var_spec"].includes(node.type)) {
			const nameNode = childForField(node, "name") ?? namedChildren(node).find((child) => child.type === "identifier");
			const name = nameNode ? nodeText(parsed.source, nameNode) : undefined;
			if (name && !currentFunction) addDefinition(node, name, node.type === "const_spec" ? "constant_declaration" : "variable_declaration", currentType);
		} else if (["field_declaration", "property_signature", "public_field_definition", "field_definition"].includes(node.type)) {
			const fieldNames = namedChildren(node).filter((child) => ["field_identifier", "property_identifier", "identifier"].includes(child.type));
			const typeNode = namedChildren(node).find((child) => !["field_identifier", "property_identifier", "identifier", "tag"].includes(child.type));
			for (const fieldName of fieldNames.slice(0, 1)) {
				const name = nodeText(parsed.source, fieldName);
				definitions.push({ kind: "field_declaration", name, symbol: name, owner: currentType, file: parsed.file, language: parsed.language, evidence: "tree-sitter:field_declaration", type: typeNode ? nodeText(parsed.source, typeNode) : undefined, ...(includeSnippets ? { text: compactText(nodeText(parsed.source, node)) } : {}), ...location(node) });
			}
		} else if (node.type === "call_expression" || node.type === "call") {
			const functionNode = callFunctionNode(node);
			const callee = functionNode ? nodeText(parsed.source, functionNode) : undefined;
			if (callee) {
				const name = simpleName(callee) ?? callee;
				candidates.push({ kind: "syntax_call", name, symbol: name, file: parsed.file, language: parsed.language, evidence: "tree-sitter:call_expression", inFunction: currentFunction, ...snippetFields(node), ...location(node) });
			}
		} else if (node.type === "selector_expression" || node.type === "member_expression" || node.type === "attribute") {
			const name = selectorName(node, parsed.source);
			if (name && !(parent?.type === "call_expression" && isCallFunctionPart(node, parent))) candidates.push({ kind: "syntax_selector", name, symbol: name, file: parsed.file, language: parsed.language, evidence: `tree-sitter:${node.type}`, inFunction: currentFunction, ...snippetFields(node), ...location(node) });
		} else if (node.type === "keyed_element" || node.type === "pair") {
			const name = keyedName(node, parsed.source);
			if (name) candidates.push({ kind: "syntax_keyed_field", name, symbol: name, file: parsed.file, language: parsed.language, evidence: `tree-sitter:${node.type}`, inFunction: currentFunction, ...snippetFields(node), ...location(node) });
		}

		for (const child of namedChildren(node)) visit(child, nextFunction, nextType, node);
	}

	visit(parsed.root);
	return { definitions, candidates };
}

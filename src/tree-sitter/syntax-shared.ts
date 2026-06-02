import { childForField, namedChildren, nodeText, type TreeSitterNode } from "./nodes.ts";

export function callFunctionNode(node: TreeSitterNode): TreeSitterNode | null {
	return childForField(node, "function") ?? node.namedChild(0);
}

export function argumentNodes(node: TreeSitterNode): TreeSitterNode[] {
	const args = childForField(node, "arguments") ?? namedChildren(node).find((child) => child.type === "argument_list" || child.type === "arguments");
	return args ? namedChildren(args) : [];
}

export function selectorName(node: TreeSitterNode, source: string): string | undefined {
	const fieldNode = childForField(node, "field") ?? childForField(node, "property") ?? childForField(node, "attribute") ?? node.namedChild(1);
	return fieldNode ? nodeText(source, fieldNode) : undefined;
}

export function selectorObject(node: TreeSitterNode): TreeSitterNode | undefined {
	return childForField(node, "operand") ?? childForField(node, "object") ?? node.namedChild(0) ?? undefined;
}

export function keyedName(node: TreeSitterNode, source: string): string | undefined {
	const keyNode = childForField(node, "key") ?? childForField(node, "name") ?? childForField(node, "field") ?? node.namedChild(0);
	return keyNode ? nodeText(source, keyNode).replace(/^['"]|['"]$/g, "") : undefined;
}

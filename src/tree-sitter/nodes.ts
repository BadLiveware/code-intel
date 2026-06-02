export interface TreeSitterPoint {
	row: number;
	column: number;
}

export interface TreeSitterNode {
	type: string;
	startIndex: number;
	endIndex: number;
	startPosition: TreeSitterPoint;
	endPosition: TreeSitterPoint;
	namedChildCount: number;
	namedChild(index: number): TreeSitterNode | null;
	childForFieldName?(name: string): TreeSitterNode | null;
}

export interface ParserLanguageSpec {
	id: string;
	wasm: string;
	extensions: string[];
}

export interface ParserBundle {
	parser: any;
	language: any;
	spec: ParserLanguageSpec;
	Query?: any;
}

export interface ParsedFile {
	file: string;
	absoluteFile: string;
	source: string;
	contentHash?: string;
	sourceLines?: string[];
	language: string;
	root: TreeSitterNode;
	bundle: ParserBundle;
}

export interface SymbolRecord {
	kind: string;
	name: string;
	file: string;
	language?: string;
	line: number;
	column: number;
	endLine: number;
	endColumn: number;
	text?: string;
	owner?: string;
	type?: string;
	symbol?: string;
	reason?: string;
	evidence?: string;
	rootSymbol?: string;
	inFunction?: string;
	signature?: string;
	arity?: number;
	metaVariables?: Record<string, unknown>;
	snippet?: string;
	exported?: boolean;
}

export function nodeText(source: string, node: TreeSitterNode): string {
	return source.slice(node.startIndex, node.endIndex);
}

export function location(node: TreeSitterNode): Pick<SymbolRecord, "line" | "column" | "endLine" | "endColumn"> {
	return {
		line: node.startPosition.row + 1,
		column: node.startPosition.column + 1,
		endLine: node.endPosition.row + 1,
		endColumn: node.endPosition.column + 1,
	};
}

export function namedChildren(node: TreeSitterNode): TreeSitterNode[] {
	const children: TreeSitterNode[] = [];
	for (let index = 0; index < node.namedChildCount; index++) {
		const child = node.namedChild(index);
		if (child) children.push(child);
	}
	return children;
}

export function childForField(node: TreeSitterNode, name: string): TreeSitterNode | null {
	try {
		return node.childForFieldName?.(name) ?? null;
	} catch {
		return null;
	}
}

export function compactText(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

export function firstSourceLine(parsed: ParsedFile, node: TreeSitterNode): string {
	parsed.sourceLines ??= parsed.source.split(/\r?\n/);
	const line = parsed.sourceLines[node.startPosition.row] ?? nodeText(parsed.source, node);
	return line.trimEnd();
}

export function simpleName(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const trimmed = value.trim();
	const parts = trimmed.split(/\.|::/);
	return parts.at(-1) || trimmed;
}

export function collectNodes(node: TreeSitterNode, predicate: (node: TreeSitterNode) => boolean, output: TreeSitterNode[] = []): TreeSitterNode[] {
	if (predicate(node)) output.push(node);
	for (const child of namedChildren(node)) collectNodes(child, predicate, output);
	return output;
}

export function visitNodes(node: TreeSitterNode, predicate: (node: TreeSitterNode) => boolean, visit: (node: TreeSitterNode) => void): void {
	if (predicate(node)) visit(node);
	for (const child of namedChildren(node)) visitNodes(child, predicate, visit);
}

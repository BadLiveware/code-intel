import type { CodeIntelConfig, CodeIntelSyntaxSearchParams, ResultDetail } from "../types.ts";
import { normalizePositiveInteger, normalizeStringArray, summarizeFileDistribution } from "../util.ts";
import { argumentNodes, callFunctionNode, keyedName, selectorName, selectorObject } from "./syntax-shared.ts";
import { languagesForSyntaxSearch, parseFiles } from "./parse.ts";
import { childForField, collectNodes, firstSourceLine, nodeText, visitNodes, type ParsedFile, type TreeSitterNode } from "./nodes.ts";

export interface TreeSitterSelectorBatchParams {
	names: string[];
	language: string;
	paths?: string[];
	maxPerName: number;
	timeoutMs: number;
	detail: ResultDetail;
}

function parseCallPattern(pattern: string): { callee: string; variables: string[] } | undefined {
	const match = /^\s*([A-Za-z_$][\w$]*(?:(?:\.|::)[A-Za-z_$][\w$]*)*)\s*\((.*)\)\s*$/.exec(pattern);
	if (!match) return undefined;
	const args = match[2].trim();
	const variables = args ? args.split(",").map((arg) => arg.trim()).map((arg) => /^\$([A-Za-z_][\w]*)$/.exec(arg)?.[1] ?? "").filter(Boolean) : [];
	return { callee: match[1], variables };
}

function parseSelectorPattern(pattern: string): { variable: string; field: string } | undefined {
	const match = /\$([A-Za-z_][\w]*)\.([A-Za-z_][\w]*)/.exec(pattern);
	return match ? { variable: match[1], field: match[2] } : undefined;
}

function parseKeyedPattern(pattern: string): { key: string; valueVariable?: string } | undefined {
	const match = /\b([A-Za-z_][\w]*)\s*:\s*(?:\$([A-Za-z_][\w]*)|[^,}\]]+)/.exec(pattern);
	return match ? { key: match[1], valueVariable: match[2] } : undefined;
}

function isRawTreeSitterQuery(pattern: string): boolean {
	return pattern.trim().startsWith("(") && !pattern.includes("$");
}

interface SyntaxMatchAccumulator {
	detail: ResultDetail;
	maxResults: number;
	matchCount: number;
	matches: Record<string, unknown>[];
	fileCounts: Map<string, number>;
}

function addSyntaxMatch(accumulator: SyntaxMatchAccumulator, parsed: ParsedFile, node: TreeSitterNode, metaVariables?: () => Record<string, unknown>): void {
	accumulator.matchCount += 1;
	accumulator.fileCounts.set(parsed.file, (accumulator.fileCounts.get(parsed.file) ?? 0) + 1);
	if (accumulator.matches.length >= accumulator.maxResults) return;
	accumulator.matches.push(normalizeSyntaxMatch(parsed, node, accumulator.detail, accumulator.detail === "snippets" ? metaVariables?.() : undefined));
}

function normalizeSyntaxMatch(parsed: ParsedFile, node: TreeSitterNode, detail: ResultDetail, metaVariables?: Record<string, unknown>): Record<string, unknown> {
	const row: Record<string, unknown> = {
		file: parsed.file,
		line: node.startPosition.row + 1,
		column: node.startPosition.column + 1,
		endLine: node.endPosition.row + 1,
		endColumn: node.endPosition.column + 1,
		language: parsed.language,
		nodeType: node.type,
	};
	if (detail === "snippets") {
		row.text = nodeText(parsed.source, node);
		row.snippet = firstSourceLine(parsed, node);
		if (metaVariables && Object.keys(metaVariables).length > 0) row.metaVariables = { single: metaVariables };
	}
	return row;
}

function collectSyntaxMatchesForCall(parsed: ParsedFile, pattern: { callee: string; variables: string[] }, accumulator: SyntaxMatchAccumulator): void {
	visitNodes(parsed.root, (candidate) => candidate.type === "call_expression", (node) => {
		const functionNode = callFunctionNode(node);
		if (!functionNode) return;
		const callee = nodeText(parsed.source, functionNode);
		const matchesCallee = pattern.callee.includes(".") || pattern.callee.includes("::") ? callee === pattern.callee : simpleName(callee) === pattern.callee;
		if (!matchesCallee) return;
		addSyntaxMatch(accumulator, parsed, node, pattern.variables.length > 0 ? () => {
			const args = argumentNodes(node);
			const variables: Record<string, string> = {};
			for (let index = 0; index < Math.min(pattern.variables.length, args.length); index++) variables[pattern.variables[index]] = nodeText(parsed.source, args[index]);
			return variables;
		} : undefined);
	});
}

function simpleName(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const trimmed = value.trim();
	const parts = trimmed.split(/\.|::/);
	return parts.at(-1) || trimmed;
}

function collectSyntaxMatchesForSelector(parsed: ParsedFile, pattern: { variable: string; field: string }, selector: string | undefined, accumulator: SyntaxMatchAccumulator): void {
	const selectorTypes = new Set(["selector_expression", "member_expression", "attribute", "field_expression", "scoped_identifier"]);
	visitNodes(parsed.root, (candidate) => selectorTypes.has(candidate.type), (node) => {
		const field = selectorName(node, parsed.source);
		if (field !== pattern.field) return;
		if (selector && selector !== node.type) return;
		addSyntaxMatch(accumulator, parsed, node, () => {
			const objectNode = selectorObject(node);
			return objectNode ? { [pattern.variable]: nodeText(parsed.source, objectNode) } : {};
		});
	});
}

function collectSyntaxMatchesForKeyed(parsed: ParsedFile, pattern: { key: string; valueVariable?: string }, selector: string | undefined, accumulator: SyntaxMatchAccumulator): void {
	const keyedTypes = new Set(["keyed_element", "pair", "field_initializer", "shorthand_field_initializer"]);
	visitNodes(parsed.root, (candidate) => keyedTypes.has(candidate.type), (node) => {
		const key = keyedName(node, parsed.source);
		if (key !== pattern.key) return;
		if (selector && selector !== node.type) return;
		addSyntaxMatch(accumulator, parsed, node, pattern.valueVariable ? () => {
			const valueNode = childForField(node, "value") ?? namedChildren(node).at(-1);
			return valueNode ? { [pattern.valueVariable as string]: nodeText(parsed.source, valueNode) } : {};
		} : undefined);
	});
}

function namedChildren(node: TreeSitterNode): TreeSitterNode[] {
	const children: TreeSitterNode[] = [];
	for (let index = 0; index < node.namedChildCount; index++) {
		const child = node.namedChild(index);
		if (child) children.push(child);
	}
	return children;
}

function collectSyntaxMatchesForRawQuery(parsed: ParsedFile, querySource: string, selector: string | undefined, accumulator: SyntaxMatchAccumulator): void {
	const Query = parsed.bundle.Query;
	if (!Query) return;
	const query = new Query(parsed.bundle.language, querySource);
	try {
		for (const match of query.matches(parsed.root) as Array<{ captures?: Array<{ name: string; node: TreeSitterNode }> }>) {
			const captures = Array.isArray(match.captures) ? match.captures : [];
			const selected = selector
				? captures.filter((capture) => capture.name === selector.replace(/^@/, "") || capture.node.type === selector)
				: captures;
			for (const capture of selected.length > 0 ? selected : captures.slice(0, 1)) addSyntaxMatch(accumulator, parsed, capture.node, () => ({ [capture.name]: nodeText(parsed.source, capture.node) }));
		}
	} finally {
		query.delete?.();
	}
}

function isIdentifierName(name: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

function distributionFromFileCounts(fileCounts: Map<string, number>): { fileCount: number; topFiles: Array<{ file: string; count: number }> } {
	return {
		fileCount: fileCounts.size,
		topFiles: [...fileCounts.entries()]
			.map(([file, count]) => ({ file, count }))
			.sort((left, right) => right.count - left.count || left.file.localeCompare(right.file))
			.slice(0, 8),
	};
}

export async function runTreeSitterSelectorBatchSearch(params: TreeSitterSelectorBatchParams, repoRoot: string, signal?: AbortSignal): Promise<Record<string, unknown>[]> {
	const names = [...new Set(params.names.map((name) => name.trim()).filter(isIdentifierName))];
	if (names.length === 0) return [];
	const maxPerName = normalizePositiveInteger(params.maxPerName, 8, 1, 50);
	const timeoutMs = normalizePositiveInteger(params.timeoutMs, 30_000, 1_000, 600_000);
	const detail: ResultDetail = params.detail === "snippets" ? "snippets" : "locations";
	const paths = normalizeStringArray(params.paths);
	const languages = languagesForSyntaxSearch(params.language, paths);
	const parsed = await parseFiles(repoRoot, languages, paths, [], [], timeoutMs, signal);
	const diagnostics = [...parsed.diagnostics];
	const selectorTypes = new Set(["selector_expression", "member_expression", "attribute", "field_expression", "scoped_identifier"]);
	const wanted = new Set(names);
	const buckets = new Map<string, { matchCount: number; matches: Record<string, unknown>[]; fileCounts: Map<string, number> }>();
	for (const name of names) buckets.set(name, { matchCount: 0, matches: [], fileCounts: new Map<string, number>() });

	for (const file of parsed.parsedFiles) {
		for (const node of collectNodes(file.root, (candidate) => selectorTypes.has(candidate.type))) {
			const field = selectorName(node, file.source);
			if (!field || !wanted.has(field)) continue;
			const bucket = buckets.get(field);
			if (!bucket) continue;
			bucket.matchCount += 1;
			bucket.fileCounts.set(file.file, (bucket.fileCounts.get(file.file) ?? 0) + 1);
			if (bucket.matches.length >= maxPerName) continue;
			let variables: Record<string, string> | undefined;
			if (detail === "snippets") {
				const objectNode = selectorObject(node);
				if (objectNode) variables = { X: nodeText(file.source, objectNode) };
			}
			bucket.matches.push(normalizeSyntaxMatch(file, node, detail, variables));
		}
	}

	return names.map((name) => {
		const bucket = buckets.get(name) ?? { matchCount: 0, matches: [], fileCounts: new Map<string, number>() };
		const matches = bucket.matches;
		return {
			kind: "selector_syntax",
			name,
			ok: diagnostics.length === 0 || bucket.matchCount > 0,
			backend: "tree-sitter",
			repoRoot,
			pattern: `$X.${name}`,
			detail,
			language: params.language,
			languages,
			paths: paths.length > 0 ? paths : ["."],
			includeGlobs: [],
			excludeGlobs: [],
			matchCount: bucket.matchCount,
			returned: matches.length,
			truncated: bucket.matchCount > matches.length,
			summary: {
				...distributionFromFileCounts(bucket.fileCounts),
				returnedFileCount: summarizeFileDistribution(matches).fileCount,
				basis: "treeSitterPatternAdapter",
			},
			matches,
			coverage: {
				filesParsed: parsed.parsedFiles.length,
				filesByLanguage: parsed.filesByLanguage,
				parsedByLanguage: parsed.parsedByLanguage,
				batched: true,
			},
			diagnostics,
			limitations: ["Syntax search matches are current-source Tree-sitter candidates, not semantic references, proof of a bug, or complete impact."],
		};
	});
}

export async function runTreeSitterSyntaxSearch(params: CodeIntelSyntaxSearchParams, repoRoot: string, config: CodeIntelConfig, signal?: AbortSignal): Promise<Record<string, unknown>> {
	const pattern = params.pattern?.trim();
	if (!pattern) throw new Error("code_intel_syntax_search requires a non-empty pattern");
	const maxResults = normalizePositiveInteger(params.maxResults, config.maxResults, 1, 500);
	const timeoutMs = normalizePositiveInteger(params.timeoutMs, config.queryTimeoutMs, 1_000, 600_000);
	const detail: ResultDetail = params.detail === "locations" ? "locations" : "snippets";
	const paths = normalizeStringArray(params.paths);
	const includeGlobs = normalizeStringArray(params.includeGlobs);
	const excludeGlobs = normalizeStringArray(params.excludeGlobs);
	const languages = languagesForSyntaxSearch(params.language, paths);
	const parsed = await parseFiles(repoRoot, languages, paths, includeGlobs, excludeGlobs, timeoutMs, signal);
	const callPattern = parseCallPattern(pattern);
	const selectorPattern = parseSelectorPattern(pattern);
	const keyedPattern = parseKeyedPattern(pattern);
	const rawQuery = isRawTreeSitterQuery(pattern);
	const diagnostics = [...parsed.diagnostics];
	const accumulator: SyntaxMatchAccumulator = { detail, maxResults, matchCount: 0, matches: [], fileCounts: new Map<string, number>() };
	if (!callPattern && !selectorPattern && !keyedPattern && !rawQuery) diagnostics.push("Unsupported Tree-sitter syntax pattern. Use foo($A), $OBJ.Field, Key: $VALUE, a wrapper containing one of those shapes, or a raw Tree-sitter S-expression query with captures.");
	for (const file of parsed.parsedFiles) {
		if (callPattern) collectSyntaxMatchesForCall(file, callPattern, accumulator);
		else if (selectorPattern) collectSyntaxMatchesForSelector(file, selectorPattern, params.selector?.trim(), accumulator);
		else if (keyedPattern) collectSyntaxMatchesForKeyed(file, keyedPattern, params.selector?.trim(), accumulator);
		else if (rawQuery) collectSyntaxMatchesForRawQuery(file, pattern, params.selector?.trim(), accumulator);
	}
	const matches = accumulator.matches;
	return {
		ok: diagnostics.length === 0 || accumulator.matchCount > 0,
		backend: "tree-sitter",
		repoRoot,
		pattern,
		detail,
		language: params.language,
		languages,
		paths: paths.length > 0 ? paths : ["."],
		includeGlobs,
		excludeGlobs,
		selector: params.selector?.trim() || undefined,
		matchCount: accumulator.matchCount,
		returned: matches.length,
		truncated: accumulator.matchCount > matches.length,
		summary: {
			...distributionFromFileCounts(accumulator.fileCounts),
			returnedFileCount: summarizeFileDistribution(matches).fileCount,
			basis: rawQuery ? "treeSitterQueryCaptures" : "treeSitterPatternAdapter",
		},
		matches,
		coverage: {
			filesParsed: parsed.parsedFiles.length,
			filesByLanguage: parsed.filesByLanguage,
			parsedByLanguage: parsed.parsedByLanguage,
		},
		diagnostics,
		limitations: ["Syntax search matches are current-source Tree-sitter candidates, not semantic references, proof of a bug, or complete impact."],
	};
}

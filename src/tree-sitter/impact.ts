import * as path from "node:path";
import type { ResultDetail } from "../types.ts";
import { IMPACT_LANGUAGES, changedFileSupportSummary } from "../impact-support.ts";
import { ensureInsideRoot } from "../repo.ts";
import { normalizeStringArray, summarizeFileDistribution } from "../util.ts";
import { parseFiles } from "./parse.ts";
import { extractFileRecords } from "./records.ts";
import type { SymbolRecord } from "./nodes.ts";

export interface TreeSitterImpactParams {
	symbols?: string[];
	changedFiles?: string[];
	paths?: string[];
	maxRootSymbols: number;
	maxResults: number;
	timeoutMs: number;
	detail: ResultDetail;
}

function withoutSnippet(row: SymbolRecord, detail: ResultDetail): SymbolRecord {
	const compact = { ...row };
	if (compact.file === "") delete (compact as Partial<SymbolRecord>).file;
	if (detail === "snippets") return compact;
	delete compact.text;
	delete compact.snippet;
	delete compact.metaVariables;
	return compact;
}

function uniqueKey(row: SymbolRecord): string {
	return [row.kind, row.file, row.line, row.column, row.name, row.inFunction ?? ""].join("\0");
}

function addUnique(rows: SymbolRecord[], seen: Set<string>, row: SymbolRecord): void {
	const key = uniqueKey(row);
	if (seen.has(key)) return;
	seen.add(key);
	rows.push(row);
}

function safeChangedFiles(repoRoot: string, changedFiles: string[]): string[] {
	const files: string[] = [];
	for (const file of changedFiles) {
		try {
			files.push(ensureInsideRoot(repoRoot, file));
		} catch {
			// Caller-facing impact output records unsupported/unsafe paths elsewhere when needed.
		}
	}
	return files;
}

function definitionRank(record: SymbolRecord): number {
	if (["function_declaration", "function_definition", "method_declaration", "method_definition", "function_variable", "function_item", "function_signature_item"].includes(record.kind)) return 0;
	if (["class_declaration", "interface_declaration", "type_alias_declaration", "type", "struct_item", "enum_item", "trait_item", "type_item", "mod_item"].includes(record.kind)) return 1;
	if (record.kind === "field_declaration") return 3;
	return 2;
}

function isTestFile(file: string): boolean {
	return /(^|\/)(__tests__|test|tests)(\/|$)/.test(file) || /(^|\/).*(\.test|\.spec)\.[cm]?[tj]sx?$/.test(file) || /(^|\/).*_test\.(go|rs)$/.test(file);
}

function fileRank(record: SymbolRecord): number {
	return isTestFile(record.file) ? 1 : 0;
}

const LOW_SIGNAL_METHOD_NAMES = new Set(["String", "Set", "Error", "Unwrap", "MarshalJSON", "UnmarshalJSON", "Len", "Less", "Swap"]);
const LOW_SIGNAL_HELPER_NAMES = new Set(["isRecord", "stringValue", "numberValue", "booleanValue", "arrayValue", "objectValue", "value", "values", "options", "config", "state", "data", "item", "items", "result", "results", "attempts", "outsideRequests"]);

function isLowSignalName(name: string): boolean {
	return LOW_SIGNAL_HELPER_NAMES.has(name) || name.length <= 3 || /^(is|as|to|from|get|set|has)[A-Z_]/.test(name);
}

function nameSignalRank(record: SymbolRecord): number {
	if (record.kind.startsWith("method_") && LOW_SIGNAL_METHOD_NAMES.has(record.name)) return 2;
	if (record.exported !== true && isLowSignalName(record.name)) return 1;
	return 0;
}

function exportRank(record: SymbolRecord): number {
	return record.exported === true ? 0 : 1;
}

function compareDefinitions(left: SymbolRecord, right: SymbolRecord): number {
	return fileRank(left) - fileRank(right) || definitionRank(left) - definitionRank(right) || nameSignalRank(left) - nameSignalRank(right) || exportRank(left) - exportRank(right) || left.file.localeCompare(right.file) || left.line - right.line || left.column - right.column || left.name.localeCompare(right.name);
}

function commonDirectoryDepth(left: string, right: string): number {
	const leftParts = path.posix.dirname(left).split("/").filter(Boolean);
	const rightParts = path.posix.dirname(right).split("/").filter(Boolean);
	let depth = 0;
	while (depth < leftParts.length && depth < rightParts.length && leftParts[depth] === rightParts[depth]) depth++;
	return depth;
}

function candidateLocalityScore(candidate: SymbolRecord, root: SymbolRecord | undefined, changedFiles: string[]): number {
	let score = 0;
	const rootFile = root?.file;
	if (rootFile) {
		if (candidate.file === rootFile) score += 8;
		else {
			const sharedDepth = commonDirectoryDepth(candidate.file, rootFile);
			score += Math.min(sharedDepth, 4) * 2;
			if (path.posix.dirname(candidate.file) === path.posix.dirname(rootFile)) score += 6;
			if (candidate.file.split("/")[0] === rootFile.split("/")[0]) score += 2;
		}
		if (isTestFile(candidate.file) && candidate.file.includes(path.posix.basename(rootFile).replace(/\.[^.]+$/, ""))) score += 5;
	}
	for (const changedFile of changedFiles) {
		if (candidate.file === changedFile) score += 3;
		else if (path.posix.dirname(candidate.file) === path.posix.dirname(changedFile)) score += 3;
	}
	if (isTestFile(candidate.file)) score += 1;
	if (isLowSignalName(candidate.name)) score -= 3;
	return score;
}

function changedFileDefinitions(definitions: SymbolRecord[], changedFiles: string[]): SymbolRecord[] {
	const changedFileSet = new Set(changedFiles);
	const changedFileOrder = new Map(changedFiles.map((file, index) => [file, index]));
	const byFile = new Map<string, SymbolRecord[]>();
	for (const definition of definitions) {
		if (!changedFileSet.has(definition.file)) continue;
		const bucket = byFile.get(definition.file) ?? [];
		bucket.push(definition);
		byFile.set(definition.file, bucket);
	}
	const groups = [...byFile.entries()]
		.map(([file, records]) => ({ file, records: records.sort(compareDefinitions), rank: Math.min(...records.map(fileRank)) }))
		.sort((left, right) => left.rank - right.rank || (changedFileOrder.get(left.file) ?? Number.MAX_SAFE_INTEGER) - (changedFileOrder.get(right.file) ?? Number.MAX_SAFE_INTEGER) || left.file.localeCompare(right.file));
	const ordered: SymbolRecord[] = [];
	const ranks = [...new Set(groups.map((group) => group.rank))].sort((left, right) => left - right);
	for (const rank of ranks) {
		const rankedGroups = groups.filter((group) => group.rank === rank);
		for (let index = 0; ; index++) {
			let added = false;
			for (const group of rankedGroups) {
				const record = group.records[index];
				if (!record) continue;
				ordered.push(record);
				added = true;
			}
			if (!added) break;
		}
	}
	return ordered;
}

export async function runTreeSitterImpact(params: TreeSitterImpactParams, repoRoot: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
	const started = Date.now();
	const changedFiles = safeChangedFiles(repoRoot, normalizeStringArray(params.changedFiles));
	const supportSummary = changedFileSupportSummary(changedFiles);
	const requestedSymbols = normalizeStringArray(params.symbols);
	const scopedPaths = normalizeStringArray(params.paths);
	if (changedFiles.length > 0 && requestedSymbols.length === 0 && scopedPaths.length === 0 && (supportSummary.supportedImpactFiles as unknown[]).length === 0) {
		return {
			ok: false,
			backend: "tree-sitter",
			repoRoot,
			roots: [],
			related: [],
			diagnostics: [],
			reason: `Changed files do not include languages supported for Tree-sitter impact mapping. Supported impact languages: ${IMPACT_LANGUAGES.join(", ")}.`,
			coverage: {
				backendsUsed: ["tree-sitter"],
				filesParsed: 0,
				filesByLanguage: {},
				parsedByLanguage: {},
				changedFiles,
				...supportSummary,
			},
			elapsedMs: Date.now() - started,
		};
	}
	const supportedImpactFiles = supportSummary.supportedImpactFiles as Array<{ file: string; languages: string[] }>;
	const onlyCppChangedFiles = changedFiles.length > 0 && supportedImpactFiles.length > 0 && supportedImpactFiles.every((file) => file.languages.includes("cpp"));
	const parsePaths = scopedPaths.length > 0 ? scopedPaths : onlyCppChangedFiles ? changedFiles : [];
	const parsed = await parseFiles(repoRoot, IMPACT_LANGUAGES, parsePaths, [], [], params.timeoutMs, signal);
	const diagnostics = [...parsed.diagnostics];
	if (parsed.parsedFiles.length === 0) {
		return {
			ok: false,
			backend: "tree-sitter",
			repoRoot,
			roots: [],
			related: [],
			diagnostics,
			reason: `No supported current-source files were parsed for Tree-sitter impact mapping. Supported impact languages: ${IMPACT_LANGUAGES.join(", ")}.`,
			coverage: {
				backendsUsed: ["tree-sitter"],
				filesParsed: 0,
				filesByLanguage: parsed.filesByLanguage,
				parsedByLanguage: parsed.parsedByLanguage,
				changedFiles,
				...supportSummary,
			},
			elapsedMs: Date.now() - started,
		};
	}

	const definitions: SymbolRecord[] = [];
	const candidates: SymbolRecord[] = [];
	for (const file of parsed.parsedFiles) {
		try {
			const records = extractFileRecords(file, params.detail);
			definitions.push(...records.definitions);
			candidates.push(...records.candidates);
		} catch (error) {
			diagnostics.push(`${file.file}: Tree-sitter record extraction failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	const rootSymbols: string[] = [];
	const roots: SymbolRecord[] = [];
	const discoveredRootNames = new Set<string>();
	const usedRootNames = new Set<string>();
	const addRoot = (symbol: string | undefined, root: SymbolRecord): void => {
		if (!symbol) return;
		discoveredRootNames.add(symbol);
		if (usedRootNames.has(symbol) || rootSymbols.length >= params.maxRootSymbols) return;
		usedRootNames.add(symbol);
		rootSymbols.push(symbol);
		roots.push(root);
	};

	for (const symbol of requestedSymbols) {
		const definition = definitions.find((record) => record.name === symbol);
		addRoot(symbol, definition ? { ...definition, reason: "explicit symbol matched current-source Tree-sitter definition" } : { kind: "queried_symbol", name: symbol, symbol, file: "", evidence: "user", reason: "explicit symbol", line: 0, column: 0, endLine: 0, endColumn: 0 });
	}

	for (const definition of changedFileDefinitions(definitions, changedFiles)) {
		addRoot(definition.name, { ...definition, reason: `current-source symbol defined in changed file ${definition.file}` });
	}

	if (rootSymbols.length === 0) {
		return {
			ok: false,
			backend: "tree-sitter",
			repoRoot,
			roots: [],
			related: [],
			diagnostics,
			reason: "No symbols or changed-file symbols were available for Tree-sitter impact mapping. The parsed files may contain only unsupported definition shapes or non-source changes.",
			filesParsed: parsed.parsedFiles.length,
			coverage: {
				backendsUsed: ["tree-sitter"],
				filesParsed: parsed.parsedFiles.length,
				filesByLanguage: parsed.filesByLanguage,
				parsedByLanguage: parsed.parsedByLanguage,
				changedFiles,
				...supportSummary,
			},
			elapsedMs: Date.now() - started,
		};
	}

	const related: SymbolRecord[] = [];
	const relatedSeen = new Set<string>();
	const rootBySymbol = new Map(roots.map((root) => [root.name, root]));
	for (const symbol of rootSymbols) {
		for (const candidate of candidates) {
			if (candidate.name !== symbol) continue;
			let reason: string;
			if (candidate.kind === "syntax_call") reason = `call expression with callee name ${symbol}`;
			else if (candidate.kind === "syntax_selector") reason = `selector/member expression with field/property name ${symbol}`;
			else reason = `keyed field/object-literal property with key ${symbol}`;
			addUnique(related, relatedSeen, { ...candidate, rootSymbol: symbol, reason });
		}
	}
	const rootOrder = new Map(rootSymbols.map((symbol, index) => [symbol, index]));
	const rankedRelated = related
		.map((row, index) => ({ row, index, locality: candidateLocalityScore(row, rootBySymbol.get(row.rootSymbol ?? ""), changedFiles) }))
		.sort((left, right) => right.locality - left.locality || (rootOrder.get(left.row.rootSymbol ?? "") ?? Number.MAX_SAFE_INTEGER) - (rootOrder.get(right.row.rootSymbol ?? "") ?? Number.MAX_SAFE_INTEGER) || left.index - right.index)
		.map((entry) => entry.row)
		.slice(0, params.maxResults);

	const outputRoots = roots.map((root) => withoutSnippet(root, params.detail));
	const outputRelated: Record<string, unknown>[] = rankedRelated.map((row) => withoutSnippet(row, params.detail) as unknown as Record<string, unknown>);
	return {
		ok: true,
		backend: "tree-sitter",
		backends: ["tree-sitter"],
		repoRoot,
		detail: params.detail,
		rootSymbols,
		roots: outputRoots,
		related: outputRelated,
		summary: {
			rootFileCount: summarizeFileDistribution(outputRoots as unknown as Record<string, unknown>[]).fileCount,
			relatedFileCount: summarizeFileDistribution(outputRelated).fileCount,
			topRelatedFiles: summarizeFileDistribution(outputRelated).topFiles,
			basis: "currentSourceSyntax",
		},
		coverage: {
			backendsUsed: ["tree-sitter"],
			filesParsed: parsed.parsedFiles.length,
			filesByLanguage: parsed.filesByLanguage,
			parsedByLanguage: parsed.parsedByLanguage,
			changedFiles,
			...supportSummary,
			truncated: related.length >= params.maxResults || discoveredRootNames.size > rootSymbols.length,
			rootSymbolsDiscovered: discoveredRootNames.size,
			rootSymbolsUsed: rootSymbols.length,
			maxResults: params.maxResults,
			maxRootSymbols: params.maxRootSymbols,
			limitations: [
				"Tree-sitter impact maps are current-source syntax read-next candidates, not type-resolved semantic references.",
				"Same-name functions, fields, and properties from unrelated types can appear; use LSP/compiler tooling for exact references when required.",
			],
		},
		diagnostics,
		limitations: [
			"Tree-sitter impact maps are current-source syntax read-next candidates, not type-resolved semantic references.",
			"Same-name functions, fields, and properties from unrelated types can appear; use LSP/compiler tooling for exact references when required.",
		],
		elapsedMs: Date.now() - started,
	};
}

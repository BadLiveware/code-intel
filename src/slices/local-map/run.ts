import type { CodeIntelConfig, CodeIntelLocalMapParams, CommandResult, ResultDetail } from "../../types.ts";
import { runTreeSitterImpact, runTreeSitterSelectorBatchSearch } from "../../tree-sitter.ts";
import { languageCapability, normalizeLanguageId } from "../../languages.ts";
import { findExecutable, runCommand, summarizeCommandBrief } from "../../exec.ts";
import { runMarkdownLocalMaps } from "./markdown.ts";
import { pathArgsForRepo } from "../../repo.ts";
import { isRecord, normalizePositiveInteger, normalizeStringArray, summarizeFileDistribution } from "../../util.ts";

const LOCAL_MAP_DEFAULT_MAX_RESULTS = 25;
const LOCAL_MAP_DEFAULT_MAX_PER_NAME = 8;
const LOCAL_MAP_MAX_NAMES = 12;
const LOCAL_MAP_MAX_ANCHORS = 6;

function unique(items: string[]): string[] {
	const seen = new Set<string>();
	const output: string[] = [];
	for (const item of items) {
		const normalized = item.trim();
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);
		output.push(normalized);
	}
	return output;
}

function rowsFromSection(section: Record<string, unknown>, key: "results" | "matches" | "callers" | "related"): Record<string, unknown>[] {
	return Array.isArray(section[key]) ? section[key].filter(isRecord) : [];
}

interface SuggestedFileInfo {
	count: number;
	score: number;
	reasons: Set<string>;
	literalCount: number;
	primaryCount: number;
	seenReasonHits: Map<string, number>;
}

function genericNamePenalty(name: string): number {
	if (name.length <= 3) return 0.35;
	if (/^(value|values|options|config|state|data|item|items|result|results|attempts|outsideRequests)$/i.test(name)) return 0.4;
	if (/^(is|as|to|from|get|set|has)[A-Z_]/.test(name)) return 0.65;
	if (/^(string|number|boolean|array|object|record)Value$/i.test(name)) return 0.55;
	return 1;
}

function sectionWeight(sectionKind: string, rowKind?: unknown): number {
	if (sectionKind === "tree_sitter_map") return 5;
	if (sectionKind === "selector_syntax") return 4;
	if (sectionKind === "literal") return 1;
	if (typeof rowKind === "string" && rowKind.startsWith("syntax_")) return 4;
	return 2;
}

function addFileReason(files: Map<string, SuggestedFileInfo>, file: unknown, reason: string, weight: number, isLiteral: boolean): void {
	if (typeof file !== "string" || !file.trim()) return;
	const entry = files.get(file) ?? { count: 0, score: 0, reasons: new Set<string>(), literalCount: 0, primaryCount: 0, seenReasonHits: new Map<string, number>() };
	const priorReasonHits = entry.seenReasonHits.get(reason) ?? 0;
	entry.seenReasonHits.set(reason, priorReasonHits + 1);
	entry.count += 1;
	if (isLiteral) entry.literalCount += 1;
	else entry.primaryCount += 1;
	entry.reasons.add(reason);
	// Repeated hits from the same evidence lane are useful for recall, but should not
	// let broad literal matches outrank one nearby syntax-backed file.
	entry.score += weight / Math.max(1, Math.sqrt(priorReasonHits + 1));
	files.set(file, entry);
}

function suggestedFilesFromSections(sections: Record<string, unknown>[], options: { literalOnly?: boolean } = {}): Array<Record<string, unknown>> {
	const files = new Map<string, SuggestedFileInfo>();
	for (const section of sections) {
		const sectionKind = typeof section.kind === "string" ? section.kind : "section";
		const name = typeof section.name === "string" ? section.name : typeof section.query === "string" ? section.query : typeof section.pattern === "string" ? section.pattern : "unknown";
		const isLiteral = sectionKind === "literal";
		const penalty = genericNamePenalty(name);
		const resolved = isRecord(section.resolved) ? section.resolved : undefined;
		if (!options.literalOnly) addFileReason(files, resolved?.file, `${sectionKind}:${name}`, sectionWeight(sectionKind) * penalty * 1.5, isLiteral);
		for (const key of ["callers", "results", "matches", "related"] as const) {
			for (const row of rowsFromSection(section, key)) {
				if (options.literalOnly && !isLiteral) continue;
				const rowName = typeof row.rootSymbol === "string" ? row.rootSymbol : typeof row.name === "string" ? row.name : name;
				addFileReason(files, row.file, `${sectionKind}:${rowName}`, sectionWeight(sectionKind, row.kind) * genericNamePenalty(rowName), isLiteral);
			}
		}
	}
	return [...files.entries()]
		.filter(([, info]) => options.literalOnly ? info.literalCount > 0 : true)
		.sort((left, right) => right[1].score - left[1].score || right[1].primaryCount - left[1].primaryCount || right[1].count - left[1].count || left[0].localeCompare(right[0]))
		.slice(0, 12)
		.map(([file, info]) => ({ file, count: info.count, score: Number(info.score.toFixed(2)), primaryCount: info.primaryCount, literalCount: info.literalCount, reasons: [...info.reasons].slice(0, 6) }));
}

function isIdentifier(name: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

function selectorPattern(name: string): string | undefined {
	if (!isIdentifier(name)) return undefined;
	return `$X.${name}`;
}

function sectionOk(section: Record<string, unknown>): boolean {
	return section.ok === true || section.ok === undefined;
}

function parseRipgrepJsonLines(stdout: string, detail: ResultDetail, maxResults: number): Array<Record<string, unknown>> {
	const matches: Array<Record<string, unknown>> = [];
	for (const line of stdout.split(/\r?\n/)) {
		if (!line.trim()) continue;
		let event: unknown;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		if (!isRecord(event) || event.type !== "match" || !isRecord(event.data)) continue;
		const data = event.data;
		const pathData = isRecord(data.path) ? data.path : undefined;
		const linesData = isRecord(data.lines) ? data.lines : undefined;
		const file = typeof pathData?.text === "string" ? pathData.text.replace(/^\.\//, "") : undefined;
		const row: Record<string, unknown> = {
			file,
			line: typeof data.line_number === "number" ? data.line_number : undefined,
			column: Array.isArray(data.submatches) && isRecord(data.submatches[0]) && typeof data.submatches[0].start === "number" ? data.submatches[0].start + 1 : undefined,
		};
		if (detail === "snippets" && typeof linesData?.text === "string") row.text = linesData.text.trimEnd();
		matches.push(Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined)));
		if (matches.length >= maxResults) break;
	}
	return matches;
}

async function runLiteralSearch(name: string, paths: string[], repoRoot: string, timeoutMs: number, maxPerName: number, detail: ResultDetail, includeIgnored: boolean, signal?: AbortSignal): Promise<Record<string, unknown>> {
	const rg = findExecutable("rg");
	if (!rg) return { kind: "literal", name, ok: false, reason: "rg is not available for bounded literal fallback." };
	let scopedPaths: string[];
	try {
		scopedPaths = pathArgsForRepo(repoRoot, paths);
	} catch (error) {
		return { kind: "literal", name, ok: false, diagnostic: error instanceof Error ? error.message : String(error) };
	}
	const ignoreArgs = includeIgnored ? ["--no-ignore"] : [];
	const command: CommandResult = await runCommand(rg, ["--json", "--fixed-strings", "--line-number", "--column", ...ignoreArgs, "--", name, ...scopedPaths], { cwd: repoRoot, timeoutMs, signal, maxOutputBytes: 500_000 });
	if (command.exitCode !== 0 && command.exitCode !== 1) {
		return { kind: "literal", name, ok: false, matchCount: 0, returned: 0, matches: [], command: summarizeCommandBrief(command) };
	}
	const matches = parseRipgrepJsonLines(command.stdout, detail, maxPerName);
	return {
		kind: "literal",
		name,
		ok: true,
		matchCount: matches.length,
		returned: matches.length,
		truncated: command.outputTruncated === true || matches.length >= maxPerName,
		detail,
		summary: summarizeFileDistribution(matches),
		matches,
		includeIgnored,
		command: summarizeCommandBrief(command),
	};
}

async function safely<T extends Record<string, unknown>>(fallback: T, run: () => Promise<Record<string, unknown>>): Promise<Record<string, unknown>> {
	try {
		return await run();
	} catch (error) {
		return {
			...fallback,
			ok: false,
			diagnostic: error instanceof Error ? error.message : String(error),
		};
	}
}

export async function runLocalMap(params: CodeIntelLocalMapParams, repoRoot: string, config: CodeIntelConfig, signal?: AbortSignal): Promise<Record<string, unknown>> {
	const detail: ResultDetail = params.detail === "snippets" ? "snippets" : "locations";
	const maxResults = normalizePositiveInteger(params.maxResults, Math.min(config.maxResults, LOCAL_MAP_DEFAULT_MAX_RESULTS), 1, 200);
	const maxPerName = normalizePositiveInteger(params.maxPerName, Math.min(config.maxResults, LOCAL_MAP_DEFAULT_MAX_PER_NAME), 1, 50);
	const timeoutMs = normalizePositiveInteger(params.timeoutMs, config.queryTimeoutMs, 1_000, 600_000);
	const anchors = unique(normalizeStringArray(params.anchors)).slice(0, LOCAL_MAP_MAX_ANCHORS);
	const explicitNames = unique(normalizeStringArray(params.names));
	const names = unique([...anchors, ...explicitNames]).slice(0, LOCAL_MAP_MAX_NAMES);
	const paths = normalizeStringArray(params.paths);
	const requestedLanguage = params.language?.trim() || undefined;
	const normalizedLanguage = requestedLanguage ? normalizeLanguageId(requestedLanguage) ?? requestedLanguage : undefined;
	const capability = normalizedLanguage ? languageCapability(normalizedLanguage) : undefined;
	const language = normalizedLanguage;
	const isMarkdown = capability?.id === "markdown";
	const includeSyntax = params.includeSyntax !== false && Boolean(language) && capability?.features.syntaxSearch !== false && capability?.parser.kind !== "scanner";

	if (names.length === 0) {
		return {
			ok: false,
			backend: "mixed",
			repoRoot,
			reason: "Provide anchors or names to map.",
			sections: [],
			limitations: ["Local maps are routing evidence; read returned files before editing or reporting findings."],
		};
	}

	const treeSitterMaps: Record<string, unknown>[] = [];
	const treeSitterMap = await safely({ kind: "tree_sitter_map", name: names.join(",") }, () => runTreeSitterImpact({ symbols: names, paths, changedFiles: [], includeIgnored: params.includeIgnored, maxRootSymbols: names.length, maxResults: Math.min(maxResults * maxPerName, 200), timeoutMs, detail }, repoRoot, signal));
	treeSitterMaps.push({ kind: "tree_sitter_map", name: names.join(","), ok: treeSitterMap.ok, rootSymbols: treeSitterMap.rootSymbols, roots: treeSitterMap.roots, results: Array.isArray(treeSitterMap.related) ? treeSitterMap.related : [], summary: treeSitterMap.summary, coverage: treeSitterMap.coverage, diagnostics: treeSitterMap.diagnostics });

	const symbolContexts: Record<string, unknown>[] = [];
	const references: Record<string, unknown>[] = [];

	const syntaxMatches: Record<string, unknown>[] = [];
	const selectorNames = includeSyntax ? names.filter((name) => selectorPattern(name) !== undefined) : [];
	if (includeSyntax && selectorNames.length > 0 && language) {
		try {
			syntaxMatches.push(...await runTreeSitterSelectorBatchSearch({ names: selectorNames, language, paths, includeIgnored: params.includeIgnored, maxPerName: Math.min(maxPerName, 8), timeoutMs, detail }, repoRoot, signal));
		} catch (error) {
			for (const name of selectorNames) syntaxMatches.push({ kind: "selector_syntax", name, pattern: selectorPattern(name), ok: false, diagnostic: error instanceof Error ? error.message : String(error) });
		}
	}

	const markdownMatches = isMarkdown ? runMarkdownLocalMaps({ names, paths, repoRoot, timeoutMs, maxPerName: Math.min(maxPerName, 12), detail, signal }) : [];

	const literalMatches: Record<string, unknown>[] = [];
	for (const name of names) {
		const literal = await safely({ kind: "literal", name }, () => runLiteralSearch(name, paths, repoRoot, timeoutMs, Math.min(maxPerName, 12), detail, params.includeIgnored === true, signal));
		literalMatches.push(literal);
	}

	const primarySections = [...treeSitterMaps, ...syntaxMatches, ...markdownMatches];
	const sections = [...primarySections, ...literalMatches];
	const suggestedFiles = suggestedFilesFromSections(sections).slice(0, maxResults);
	const primarySuggestedFiles = suggestedFilesFromSections(primarySections).slice(0, maxResults);
	const literalFallbackFiles = suggestedFilesFromSections(literalMatches, { literalOnly: true }).slice(0, Math.min(maxResults, 12));
	const distributionRows = suggestedFiles.map((file) => ({ file: file.file }));
	const truncated = anchors.length < normalizeStringArray(params.anchors).length || names.length < unique([...anchors, ...explicitNames]).length || suggestedFiles.length >= maxResults;

	return {
		ok: sections.some(sectionOk),
		backend: "mixed",
		backends: ["tree-sitter", "rg"],
		repoRoot,
		detail,
		anchors,
		names,
		paths,
		includeIgnored: params.includeIgnored === true,
		language,
		sections: {
			treeSitterMaps,
			symbolContexts,
			references,
			syntaxMatches,
			markdownMatches,
			literalMatches,
		},
		summary: {
			...summarizeFileDistribution(distributionRows),
			suggestedFiles,
			primarySuggestedFiles,
			literalFallbackFiles,
			basis: "weightedTreeSitterSyntaxThenLiteralFallback",
		},
		coverage: {
			maxNames: LOCAL_MAP_MAX_NAMES,
			maxAnchors: LOCAL_MAP_MAX_ANCHORS,
			maxPerName,
			maxResults,
			includeSyntax,
			includeIgnored: params.includeIgnored === true,
			languageResolvedFrom: requestedLanguage && requestedLanguage !== language ? requestedLanguage : undefined,
			syntaxSearches: syntaxMatches.length,
			markdownSearches: markdownMatches.length,
			syntaxParsePasses: includeSyntax && selectorNames.length > 0 ? 1 : 0,
			truncated,
		},
		limitations: [
			"Use local maps as read-next maps built from Tree-sitter current-source syntax and bounded literal fallback.",
			"Read selected source files to confirm usage and compatibility claims.",
			"Use rg afterward for literal text, comments/docs, generated files, or unsupported-language gaps.",
		],
	};
}

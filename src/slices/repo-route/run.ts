import * as fs from "node:fs";
import * as path from "node:path";
import type { CodeIntelConfig, CodeIntelRepoRouteParams } from "../../types.ts";
import { collectRepoFiles } from "../../file-discovery.ts";
import { LANGUAGE_SPECS } from "../../languages.ts";
import { ensureInsideRoot } from "../../repo.ts";
import { normalizePositiveInteger, normalizeStringArray } from "../../util.ts";

const EXCLUDED_DIRS = new Set([".git", ".hg", ".svn", "node_modules", "vendor", "contrib", "build", "build_debug", "build_release", "dist", "target", ".cache", "__pycache__"]);
const BINARY_OR_NOISY_EXTENSIONS = new Set([".pyc", ".pyo", ".o", ".a", ".so", ".dylib", ".dll", ".log", ".tmp", ".out", ".err", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".zip", ".gz", ".xz", ".zst"]);

interface RouteFile {
	file: string;
	absolute: string;
	language?: string;
}

type RouteEvidence = {
	kind: string;
	term: string;
	line?: number;
	score: number;
	category?: string;
	generic?: boolean;
	exact?: boolean;
};

function languageFor(file: string): string | undefined {
	const ext = path.extname(file);
	return LANGUAGE_SPECS.find((spec) => spec.extensions.includes(ext))?.id;
}

function safePaths(repoRoot: string, paths: string[] | undefined, diagnostics: string[]): string[] {
	const roots = paths && paths.length > 0 ? paths : ["."];
	const output: string[] = [];
	for (const item of roots) {
		try {
			output.push(ensureInsideRoot(repoRoot, item));
		} catch (error) {
			diagnostics.push(`${item}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return output;
}

function shouldSkipFile(file: string): boolean {
	return BINARY_OR_NOISY_EXTENSIONS.has(path.extname(file).toLowerCase()) || /(^|\/)node\/logs\//.test(file);
}

function collectRouteFiles(repoRoot: string, roots: string[], maxFiles: number, timeoutMs: number, diagnostics: string[], includeIgnored: boolean, signal?: AbortSignal): { files: RouteFile[]; truncated: boolean; gitIgnoreApplied: boolean; explicitIgnoredPathScanned: boolean } {
	const discovered = collectRepoFiles(repoRoot, { paths: roots, maxFiles, timeoutMs, diagnostics, signal, includeIgnored, excludedDirNames: EXCLUDED_DIRS });
	return {
		files: discovered.files.filter((file) => !shouldSkipFile(file.file)).map((file) => ({ file: file.file, absolute: file.absolute, language: languageFor(file.file) })),
		truncated: discovered.truncated,
		gitIgnoreApplied: discovered.gitIgnoreApplied,
		explicitIgnoredPathScanned: discovered.explicitIgnoredPathScanned,
	};
}

function isTestPath(file: string): boolean {
	return /(^|\/)(__tests__|test|tests|spec|integration|gtest)(\/|$)/i.test(file) || /(^|\/).*(\.test|\.spec)\.[cm]?[tj]sx?$/i.test(file) || /(^|\/).*_test\.go$/i.test(file);
}

const DOCUMENTATION_EXTENSIONS = new Set([".md", ".markdown", ".mdx", ".mdc", ".txt", ".rst"]);
const LOW_SIGNAL_TERMS = new Set(["get", "set", "new", "run", "load", "save", "main", "test", "init", "start", "stop", "handle", "helper", "util", "utils"]);

function fileCategory(file: RouteFile): "source" | "test" | "doc" | "other" {
	if (isTestPath(file.file)) return "test";
	if (DOCUMENTATION_EXTENSIONS.has(path.extname(file.file).toLowerCase())) return "doc";
	return file.language ? "source" : "other";
}

function isGenericTerm(term: string): boolean {
	const normalized = term.trim().toLowerCase();
	return LOW_SIGNAL_TERMS.has(normalized) || normalized.length <= 3;
}

function declaredSymbolContains(line: string, term: string): boolean {
	const needle = term.toLowerCase();
	const declarations = [
		/\b(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|const|let|var|enum|def|func|struct)\s+([A-Za-z_][A-Za-z0-9_]*)/i,
		/\b(?:public|private|protected|internal|static|virtual|override|async|readonly)\b.*?\b([A-Za-z_][A-Za-z0-9_]*)\s*(?:[({=:]|=>)/i,
	];
	return declarations.some((pattern) => pattern.exec(line)?.[1]?.toLowerCase().includes(needle));
}

function literalKind(file: RouteFile, line: string, term: string): string {
	if (declaredSymbolContains(line, term)) return "declaration";
	const category = fileCategory(file);
	if (category === "source") return "source_literal";
	if (category === "test") return "test_literal";
	if (category === "doc") return "doc_literal";
	return "literal";
}

function evidenceScore(kind: string, generic: boolean, category?: string, exact?: boolean): number {
	let score = 0;
	if (kind === "basename") score = exact ? 34 : 24;
	else if (kind === "path") score = exact ? 24 : 16;
	else if (kind === "declaration") score = category === "test" ? 10 : 26;
	else if (kind === "source_literal") score = 7;
	else if (kind === "test_literal") score = 2.5;
	else if (kind === "doc_literal") score = 1.5;
	else score = 4;
	if (generic) score *= kind === "declaration" || kind === "basename" || kind === "path" ? 0.65 : 0.35;
	return score;
}

function lineMatches(file: RouteFile, terms: string[], maxMatches: number): RouteEvidence[] {
	let source: string;
	try {
		source = fs.readFileSync(file.absolute, "utf-8");
	} catch {
		return [];
	}
	const lines = source.split(/\r?\n/);
	const category = fileCategory(file);
	const matches: RouteEvidence[] = [];
	for (const term of terms) {
		const needle = term.toLowerCase();
		for (let index = 0; index < lines.length; index++) {
			const line = lines[index];
			if (line.toLowerCase().includes(needle)) {
				const kind = literalKind(file, line, term);
				const generic = isGenericTerm(term);
				matches.push({ kind, term, line: index + 1, category, generic, score: evidenceScore(kind, generic, category) });
				break;
			}
		}
		if (matches.length >= maxMatches) break;
	}
	return matches;
}

function pathEvidence(file: string, terms: string[]): RouteEvidence[] {
	const lower = file.toLowerCase();
	const base = path.posix.basename(file).toLowerCase();
	const baseWithoutExt = base.slice(0, base.length - path.posix.extname(base).length);
	const evidence: RouteEvidence[] = [];
	for (const term of terms) {
		const needle = term.toLowerCase();
		const generic = isGenericTerm(term);
		if (base.includes(needle)) {
			const exact = baseWithoutExt === needle;
			evidence.push({ kind: "basename", term, generic, exact, score: evidenceScore("basename", generic, undefined, exact) });
		} else if (lower.includes(needle)) {
			const exact = lower.split("/").some((part) => part === needle);
			evidence.push({ kind: "path", term, generic, exact, score: evidenceScore("path", generic, undefined, exact) });
		}
	}
	return evidence;
}

function candidateScore(file: RouteFile, evidence: RouteEvidence[], terms: string[]): number {
	const matchedTerms = new Set(evidence.map((row) => row.term.toLowerCase()));
	const category = fileCategory(file);
	const base = evidence.reduce((sum, row) => sum + row.score, 0);
	const multiTermBonus = matchedTerms.size > 1 ? Math.min(16, (matchedTerms.size - 1) * 8) : 0;
	const categoryAdjustment = category === "source" ? 4 : category === "test" ? -8 : category === "doc" ? -6 : 0;
	const genericOnlyPenalty = evidence.length > 0 && evidence.every((row) => row.generic) ? -8 : 0;
	const missedTermPenalty = Math.max(0, terms.length - matchedTerms.size) * -1.5;
	return Number((base + multiTermBonus + categoryAdjustment + genericOnlyPenalty + missedTermPenalty).toFixed(2));
}

function routeGuidance(candidates: Array<{ file: string; score: number; evidence: RouteEvidence[] }>, terms: string[], page: { maxResults: number; offset: number; remainingCount: number; nextOffset?: number }, scanTruncated: boolean): string[] {
	const guidance: string[] = [];
	const genericTerms = terms.filter(isGenericTerm);
	const smallRemainder = page.remainingCount > 0 && !scanTruncated && page.remainingCount <= Math.max(page.maxResults, Math.ceil(candidates.length * 0.15));
	if (smallRemainder && page.nextOffset !== undefined) guidance.push(`Only ${page.remainingCount} more candidate(s) remain; rerun with offset=${page.nextOffset} to inspect the next page.`);
	if (scanTruncated || (page.remainingCount > 0 && !smallRemainder)) guidance.push("Results were truncated; narrow with `paths`, more exact API/symbol terms, or a smaller route query.");
	if (candidates.length >= 12 || terms.length >= 3) guidance.push("Broad route query detected; split unrelated terms or use `code_intel_local_map` once you know an anchor symbol.");
	if (genericTerms.length > 0) guidance.push(`Generic term(s) ${genericTerms.join(", ")} can be noisy; pair them with domain terms or scope paths.`);
	return [...new Set(guidance)].slice(0, 4);
}

export async function runRepoRoute(params: CodeIntelRepoRouteParams, repoRoot: string, config: CodeIntelConfig, signal?: AbortSignal): Promise<Record<string, unknown>> {
	const started = Date.now();
	const diagnostics: string[] = [];
	const terms = [...new Set(normalizeStringArray(params.terms).filter((term) => term.length >= 2))];
	if (terms.length === 0) return { ok: false, repoRoot, candidates: [], diagnostics: ["At least one route term is required"], elapsedMs: Date.now() - started };
	const maxResults = normalizePositiveInteger(params.maxResults, Math.min(config.maxResults, 30), 1, 200);
	const offset = normalizePositiveInteger(params.offset, 0, 0, 200_000);
	const maxFiles = normalizePositiveInteger(params.maxFiles, 20_000, 100, 200_000);
	const maxMatchesPerFile = normalizePositiveInteger(params.maxMatchesPerFile, 5, 1, 25);
	const timeoutMs = normalizePositiveInteger(params.timeoutMs, config.queryTimeoutMs, 1_000, 600_000);
	const roots = safePaths(repoRoot, params.paths, diagnostics);
	const scan = collectRouteFiles(repoRoot, roots, maxFiles, timeoutMs, diagnostics, params.includeIgnored === true, signal);
	const candidates: Array<{ file: string; language?: string; category: string; score: number; evidence: RouteEvidence[]; matchedTermCount: number }> = [];
	for (const file of scan.files) {
		const pathRows = pathEvidence(file.file, terms);
		const literals = lineMatches(file, terms, maxMatchesPerFile);
		const evidence = [...pathRows, ...literals].sort((left, right) => right.score - left.score || String(left.line ?? 0).localeCompare(String(right.line ?? 0)));
		if (evidence.length === 0) continue;
		const score = candidateScore(file, evidence, terms);
		const matchedTermCount = new Set(evidence.map((row) => row.term.toLowerCase())).size;
		candidates.push({ file: file.file, language: file.language, category: fileCategory(file), score, evidence, matchedTermCount });
	}
	candidates.sort((left, right) => right.score - left.score || right.matchedTermCount - left.matchedTermCount || String(left.file).localeCompare(String(right.file)));
	const returned = candidates.slice(offset, offset + maxResults);
	const nextOffset = offset + returned.length < candidates.length ? offset + returned.length : undefined;
	const remainingCount = Math.max(0, candidates.length - (offset + returned.length));
	const guidance = routeGuidance(candidates, terms, { maxResults, offset, remainingCount, nextOffset }, scan.truncated);
	return {
		ok: true,
		repoRoot,
		terms,
		candidates: returned,
		guidance,
		summary: { candidateCount: candidates.length, returnedCount: returned.length, filesScanned: scan.files.length, offset, remainingCount, nextOffset, broadQuery: guidance.length > 0 },
		coverage: { truncated: scan.truncated || remainingCount > 0, maxResults, offset, nextOffset, remainingCount, maxFiles, maxMatchesPerFile, roots, gitIgnoreApplied: scan.gitIgnoreApplied, explicitIgnoredPathScanned: scan.explicitIgnoredPathScanned, includeIgnored: params.includeIgnored === true },
		diagnostics,
		limitations: ["Repo route ranks files by path, declaration-like, and literal evidence only; inspect returned files before making implementation claims."],
		elapsedMs: Date.now() - started,
	};
}

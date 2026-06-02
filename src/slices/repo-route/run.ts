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

function lineMatches(file: RouteFile, terms: string[], maxMatches: number): Array<{ term: string; line: number }> {
	let source: string;
	try {
		source = fs.readFileSync(file.absolute, "utf-8");
	} catch {
		return [];
	}
	const lines = source.split(/\r?\n/);
	const matches: Array<{ term: string; line: number }> = [];
	for (const term of terms) {
		const needle = term.toLowerCase();
		for (let index = 0; index < lines.length; index++) {
			if (lines[index].toLowerCase().includes(needle)) {
				matches.push({ term, line: index + 1 });
				break;
			}
		}
		if (matches.length >= maxMatches) break;
	}
	return matches;
}

function isTestPath(file: string): boolean {
	return /(^|\/)(__tests__|test|tests|spec|integration|gtest)(\/|$)/i.test(file) || /(^|\/).*(\.test|\.spec)\.[cm]?[tj]sx?$/i.test(file) || /(^|\/).*_test\.go$/i.test(file);
}

function pathEvidence(file: string, terms: string[]): Array<{ kind: string; term: string }> {
	const lower = file.toLowerCase();
	const base = path.posix.basename(file).toLowerCase();
	const evidence: Array<{ kind: string; term: string }> = [];
	for (const term of terms) {
		const needle = term.toLowerCase();
		if (base.includes(needle)) evidence.push({ kind: "basename", term });
		else if (lower.includes(needle)) evidence.push({ kind: "path", term });
	}
	return evidence;
}

export async function runRepoRoute(params: CodeIntelRepoRouteParams, repoRoot: string, config: CodeIntelConfig, signal?: AbortSignal): Promise<Record<string, unknown>> {
	const started = Date.now();
	const diagnostics: string[] = [];
	const terms = [...new Set(normalizeStringArray(params.terms).filter((term) => term.length >= 2))];
	if (terms.length === 0) return { ok: false, repoRoot, candidates: [], diagnostics: ["At least one route term is required"], elapsedMs: Date.now() - started };
	const maxResults = normalizePositiveInteger(params.maxResults, Math.min(config.maxResults, 30), 1, 200);
	const maxFiles = normalizePositiveInteger(params.maxFiles, 20_000, 100, 200_000);
	const maxMatchesPerFile = normalizePositiveInteger(params.maxMatchesPerFile, 5, 1, 25);
	const timeoutMs = normalizePositiveInteger(params.timeoutMs, config.queryTimeoutMs, 1_000, 600_000);
	const roots = safePaths(repoRoot, params.paths, diagnostics);
	const scan = collectRouteFiles(repoRoot, roots, maxFiles, timeoutMs, diagnostics, params.includeIgnored === true, signal);
	const candidates = [];
	for (const file of scan.files) {
		const pathRows = pathEvidence(file.file, terms);
		const literals = lineMatches(file, terms, maxMatchesPerFile);
		if (pathRows.length === 0 && literals.length === 0) continue;
		const score = pathRows.reduce((sum, row) => sum + (row.kind === "basename" ? 8 : 4), 0) + literals.length * 6 + (file.language ? 1 : 0) - (isTestPath(file.file) ? 10 : 0);
		candidates.push({ file: file.file, language: file.language, score, evidence: [...pathRows, ...literals.map((row) => ({ kind: "literal", term: row.term, line: row.line }))] });
	}
	candidates.sort((left, right) => right.score - left.score || String(left.file).localeCompare(String(right.file)));
	const returned = candidates.slice(0, maxResults);
	return {
		ok: true,
		repoRoot,
		terms,
		candidates: returned,
		summary: { candidateCount: candidates.length, returnedCount: returned.length, filesScanned: scan.files.length },
		coverage: { truncated: scan.truncated || candidates.length > maxResults, maxResults, maxFiles, maxMatchesPerFile, roots, gitIgnoreApplied: scan.gitIgnoreApplied, explicitIgnoredPathScanned: scan.explicitIgnoredPathScanned, includeIgnored: params.includeIgnored === true },
		diagnostics,
		limitations: ["Repo route ranks files by path and literal evidence only; inspect returned files before making implementation claims."],
		elapsedMs: Date.now() - started,
	};
}

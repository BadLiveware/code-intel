import { compactCodeIntelOutput } from "../../compact-output.ts";
import { resolveRepoRootsFromCwd } from "../../repo.ts";
import { booleanParam, confirmReferencesProperty, detailProperty, maxResultsProperty, numberParam, objectSchema, repoRootProperty, stringArrayParam, stringParam, timeoutProperty } from "../../standalone/schema.ts";
import type { CodeIntelEnv } from "../../standalone/env.ts";
import { normalizeStandalonePathParams } from "../../standalone/path-params.ts";
import type { CodeIntelToolSpec } from "../../tool-registry.ts";
import type { CodeIntelFileOutlineParams, CodeIntelRepoOverviewParams, CodeIntelRepoRouteParams, CodeIntelTestMapParams } from "../../types.ts";
import { runRepoRoute } from "../repo-route/run.ts";
import { runFileOutline, runRepoOverview, runTestMap } from "./run.ts";

async function withRepoRoot<P extends { repoRoot?: string }>(params: P, env: CodeIntelEnv, run: (params: P, repoRoot: string) => Promise<Record<string, unknown>>, kind: "overview" | "outline" | "route" | "tests") {
	const roots = await resolveRepoRootsFromCwd(env.cwd, params.repoRoot);
	const effectiveParams = normalizeStandalonePathParams(params as unknown as Record<string, unknown>, env, roots.repoRoot) as unknown as P;
	const payload = await run(effectiveParams, roots.repoRoot);
	if (roots.diagnostics.length > 0) payload.diagnostics = [...roots.diagnostics, ...(Array.isArray(payload.diagnostics) ? payload.diagnostics : [])];
	return { contentText: compactCodeIntelOutput(kind, payload), details: payload };
}

export const repoOverviewToolSpec: CodeIntelToolSpec<CodeIntelRepoOverviewParams> = {
	name: "code_intel_repo_overview",
	title: "Code Intelligence Repo Overview",
	description: "Build a deterministic large-repo-safe orientation map. Shape tier summarizes directories; files tier adds capped top-level declarations for scoped paths.",
	promptSnippet: "Use first in large unfamiliar repositories to see objective structure before broad searches.",
	promptGuidelines: [
		"Use code_intel_repo_overview to answer what exists and where to start before global rg/find in large repos.",
		"Start with tier:'shape' at broad scope, then tier:'files' for an explicit subtree when declarations will help choose source reads.",
		"Use paths, counts, languages, declarations, and truncation as objective navigation facts, then read source for semantic roles.",
	],
	inputSchema: objectSchema({
		repoRoot: repoRootProperty,
		paths: stringArrayParam("Repo-relative directories or files to summarize. Defaults to repository root."),
		tier: { enum: ["shape", "files"], description: "shape summarizes directory counts; files adds capped file declarations for scoped paths. Default shape." },
		maxDepth: numberParam("Maximum directory depth. Defaults to 2 for shape, 3 for files."),
		maxDirs: numberParam("Maximum directories to visit before truncating."),
		maxFilesPerDir: numberParam("Maximum files listed per directory. Defaults low for shape, higher for files."),
		maxSymbolsPerFile: numberParam("Maximum declarations shown per file in files tier. Default 8."),
		includeGlobs: stringArrayParam("Additional glob-like include patterns."),
		excludeGlobs: stringArrayParam("Additional glob-like exclude patterns. Leading ! is optional."),
		includeGenerated: booleanParam("Include generated-looking directories. Default false."),
		includeVendor: booleanParam("Include vendor/contrib/dependency directories. Default false."),
		includeIgnored: booleanParam("Include files ignored by git ignore rules in broad repository scans. Explicit paths are inspectable either way. Default false."),
		timeoutMs: timeoutProperty,
	}),
	mutates: false,
	run: async (params, env, signal) => withRepoRoot(params, env, (effectiveParams, repoRoot) => runRepoOverview(effectiveParams, repoRoot, env.config, signal), "overview"),
};

export const fileOutlineToolSpec: CodeIntelToolSpec<CodeIntelFileOutlineParams> = {
	name: "code_intel_file_outline",
	title: "Code Intelligence File Outline",
	description: "Parse one source file and return imports/includes plus language-native top-level declarations with locations.",
	promptSnippet: "Use to inspect what is inside a file before reading the full source.",
	promptGuidelines: [
		"Use code_intel_file_outline after repo overview points at a candidate file and before reading a very large source file.",
		"Use imports/includes, declaration names/kinds, line ranges, symbolTargets, and readHints to pick precise reads or symbol operations.",
		"Use this as the fast orientation step before source reads, targeted symbol reads, or anchor-relative edits.",
	],
	inputSchema: objectSchema({
		repoRoot: repoRootProperty,
		path: stringParam("Repo-relative file to outline."),
		includeImports: booleanParam("Include imports/includes when available. Default true."),
		includeNonExported: booleanParam("Reserved for language-specific filtering; current output is syntax declarations with exported markers where available."),
		maxSymbols: numberParam("Maximum declarations returned. Default 250."),
		timeoutMs: timeoutProperty,
		detail: detailProperty,
	}, ["path"]),
	mutates: false,
	run: async (params, env, signal) => withRepoRoot(params, env, (effectiveParams, repoRoot) => runFileOutline(effectiveParams, repoRoot, env.config, signal), "outline"),
};

export const repoRouteToolSpec: CodeIntelToolSpec<CodeIntelRepoRouteParams> = {
	name: "code_intel_repo_route",
	title: "Code Intelligence Repo Route",
	description: "Rank likely files for concept or API terms using bounded path, declaration-like, and literal evidence without dumping raw search output.",
	promptSnippet: "Use when you need to find where a concept is implemented before choosing files to read.",
	promptGuidelines: [
		"Use code_intel_repo_route after broad overview when you have concept terms such as API names, feature names, or function names but no exact anchor file yet.",
		"Scope paths for large repositories; route output ranks files by path, declaration-like, and literal evidence, not semantic proof.",
		"If broad-query guidance appears, narrow with paths, split generic terms, or switch to code_intel_local_map once anchors are known.",
		"Use returned files with code_intel_file_outline, source reads, impact maps, or test maps before making claims.",
	],
	inputSchema: objectSchema({
		repoRoot: repoRootProperty,
		terms: stringArrayParam("Concept, API, symbol, or domain terms to route, e.g. ['promql', 'over_time']."),
		paths: stringArrayParam("Repo-relative files or directories to search. Scope this in large repos."),
		maxResults: maxResultsProperty,
		offset: numberParam("Pagination offset into the ranked candidates. Use `nextOffset` from a prior truncated result to fetch the next page without increasing maxResults."),
		maxFiles: numberParam("Maximum files to scan before truncating. Default 20000."),
		maxMatchesPerFile: numberParam("Maximum literal evidence rows per file. Default 5."),
		includeIgnored: booleanParam("Include files ignored by git ignore rules during broad routing. Explicit paths are inspectable either way. Default false."),
		timeoutMs: timeoutProperty,
	}, ["terms"]),
	mutates: false,
	run: async (params, env, signal) => withRepoRoot(params, env, (effectiveParams, repoRoot) => runRepoRoute(effectiveParams, repoRoot, env.config, signal), "route"),
};

export const testMapToolSpec: CodeIntelToolSpec<CodeIntelTestMapParams> = {
	name: "code_intel_test_map",
	title: "Code Intelligence Test Map",
	description: "Find evidence-ranked test candidates for a file or symbols using bounded test-root discovery, path/name evidence, and literal matches.",
	promptSnippet: "Use to find likely tests to run or inspect for a scoped file/symbol.",
	promptGuidelines: [
		"Use code_intel_test_map to choose likely tests to inspect or run for a source file, symbol, or domain term.",
		"Provide path plus symbols or domain names when possible, especially for non-code tests such as SQL fixtures.",
		"Use the returned evidence to read candidate tests and select focused validation commands.",
	],
	inputSchema: objectSchema({
		repoRoot: repoRootProperty,
		path: stringParam("Repo-relative source file to find related tests for."),
		symbols: stringArrayParam("Symbols to use as test search terms."),
		names: stringArrayParam("Domain names, strings, APIs, table names, or other literals to use as test search terms."),
		testPaths: stringArrayParam("Explicit repo-relative test directories/files to search. Defaults to discovered test roots."),
		maxResults: maxResultsProperty,
		maxLiteralMatches: numberParam("Maximum literal evidence rows per candidate. Default 5."),
		includeIgnored: booleanParam("Include files ignored by git ignore rules in test discovery. Explicit testPaths are inspectable either way. Default false."),
		confirmReferences: confirmReferencesProperty,
		maxReferenceRoots: numberParam("Maximum roots to confirm when confirmReferences is set."),
		maxReferenceResults: numberParam("Maximum reference rows returned when confirmReferences is set."),
		timeoutMs: timeoutProperty,
		detail: detailProperty,
	}),
	mutates: false,
	run: async (params, env, signal) => withRepoRoot(params, env, (effectiveParams, repoRoot) => runTestMap(effectiveParams, repoRoot, env.config, signal), "tests"),
};

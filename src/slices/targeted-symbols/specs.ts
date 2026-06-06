import { compactCodeIntelOutput } from "../../compact-output.ts";
import { resolveRepoRootsFromCwd } from "../../repo.ts";
import { booleanParam, enumParam, maxResultsProperty, numberParam, objectSchema, recordParam, repoRootProperty, sourceDetailProperty, stringArrayParam, stringParam, timeoutProperty } from "../../standalone/schema.ts";
import type { CodeIntelEnv } from "../../standalone/env.ts";
import { normalizeStandalonePathParams } from "../../standalone/path-params.ts";
import type { CodeIntelToolSpec } from "../../tool-registry.ts";
import type { CodeIntelPostEditMapParams, CodeIntelReadSymbolParams } from "../../types.ts";
import { runPostEditMap, runReadSymbol } from "./run.ts";

const selectorProperties = {
	repoRoot: repoRootProperty,
	target: recordParam("Symbol target object returned by locator-mode code-intel tools. Preferred over reconstructing path/symbol fields manually."),
	path: stringParam("Repo-relative file path. Required when target is omitted."),
	symbol: stringParam("Symbol/declaration name. Prefer target when available."),
	name: stringParam("Alias for symbol."),
	owner: stringParam("Optional owner such as class, struct, receiver, impl, or namespace."),
	kind: stringParam("Optional declaration kind filter."),
	signature: stringParam("Optional signature text to disambiguate overload-like declarations."),
	symbolRef: stringParam("Stable symbolRef emitted by locator-mode code-intel tools."),
	rangeId: stringParam("Stable range id emitted by locator-mode code-intel tools."),
};

export const readSymbolToolSpec: CodeIntelToolSpec<CodeIntelReadSymbolParams> = {
	name: "code_intel_read_symbol",
	title: "Code Intelligence Read Symbol",
	description: "Read one symbol/declaration/Markdown section by a code-intel symbolTarget or explicit path/symbol selector, returning a complete bounded source segment when possible.",
	promptSnippet: "Use after locator-mode code-intel output when you need exact source for one function, method, type, constant, variable, field, property, or Markdown section without reading the whole file.",
	promptGuidelines: [
		"Prefer passing a symbolTarget returned by code_intel_file_outline or another locator tool; target objects avoid brittle identity reconstruction.",
		"Use a complete-segment source result as the source read and continue from it when it is fresh and sufficient for the edit/review.",
		"For functions and methods, the tool returns the full declaration body by default. contextLines are mainly for small declarations and adjacent comments/attributes.",
		"Use referenced-definition context for same-file constants, variables, fields/properties, and types when that local context helps the next step.",
	],
	inputSchema: objectSchema({
		...selectorProperties,
		line: numberParam("Fallback: line whose enclosing declaration should be read, for diagnostic/location-originated workflows."),
		column: numberParam("Fallback: column for enclosing-declaration lookup."),
		contextLines: numberParam("Extra surrounding lines for small declarations. Function-like declarations are returned whole by default."),
		include: { type: "array", items: enumParam(["referenced-constants", "referenced-vars", "referenced-types"], "Referenced context kind."), description: "Optional one-hop same-file referenced definitions to include. Functions/helpers are deferred." },
		maxContextSegments: numberParam("Maximum referenced-definition segments returned. Default 8."),
		maxBytes: numberParam("Maximum bytes per returned source segment. Default 30000."),
		timeoutMs: timeoutProperty,
		detail: sourceDetailProperty,
	}),
	mutates: false,
	run: async (params, env: CodeIntelEnv, signal?: AbortSignal) => {
		const roots = await resolveRepoRootsFromCwd(env.cwd, params.repoRoot);
		const effectiveParams = normalizeStandalonePathParams(params as unknown as Record<string, unknown>, env, roots.repoRoot) as unknown as CodeIntelReadSymbolParams;
		const payload = await runReadSymbol(effectiveParams, roots.repoRoot, env.config, signal);
		if (roots.diagnostics.length > 0) payload.diagnostics = [...roots.diagnostics, ...(Array.isArray(payload.diagnostics) ? payload.diagnostics : [])];
		return { contentText: compactCodeIntelOutput("read_symbol", payload), details: payload };
	},
};

export const postEditMapToolSpec: CodeIntelToolSpec<CodeIntelPostEditMapParams> = {
	name: "code_intel_post_edit_map",
	title: "Code Intelligence Post-edit Map",
	description: "Build a read-only follow-up map after edits/writes: changed symbols, likely callers/tests, and optional diagnostic-focused locations. Standalone callers should pass changedFiles or baseRef explicitly.",
	promptSnippet: "Use after editing or writing files to decide what to inspect or validate next without re-reading complete segments unnecessarily.",
	promptGuidelines: [
		"Use code_intel_post_edit_map after edit/write when changed-symbol, caller, test, or diagnostic follow-up context would improve confidence.",
		"Use returned readHints or code_intel_read_symbol when source is needed for follow-up inspection.",
		"Use includeDiagnostics:true when current touched-file diagnostics would help decide the next fix or validation step.",
		"Use diagnostic-focused targets to prioritize source reads and fixes; pair the result with project-native validation when needed.",
		"Treat diagnostic provenance/freshness as trust context: supplied diagnostics default to unknown freshness, collected diagnostics are not baseline-compared proof.",
		"If phaseTimings or validationHints report a partial, failed, aborted, or slow phase, rely on completed rows that remain present but validate the missing phase separately.",
		"In standalone/Claude Code use, pass changedFiles or baseRef explicitly because Pi's touched-file session tracker is not available.",
	],
	inputSchema: objectSchema({
		repoRoot: repoRootProperty,
		changedFiles: stringArrayParam("Files edited or written in the current task. Standalone callers should pass this explicitly unless baseRef is supplied."),
		baseRef: stringParam("Optional git base ref for discovering changed files."),
		includeChangedSymbols: booleanParam("Include changed declaration ranges/read hints. Default true."),
		includeCallers: booleanParam("Include likely caller/consumer rows via impact map. Default true."),
		includeTests: booleanParam("Include likely test candidates. Default true."),
		includeDiagnostics: booleanParam("Collect current touched-file diagnostics from applicable providers such as TypeScript, gopls, Rust Analyzer, Python providers, clangd, csharp-ls, ShellCheck, zsh -n, or markdownlint-cli2."),
		diagnostics: { type: "array", items: recordParam("Diagnostic row."), description: "Optional LSP/compiler diagnostics with path, line, column, endLine/endColumn, severity, source, code, and message." },
		avoidReReadingCompleteReturnedSegments: booleanParam("Avoid re-suggesting exact complete source segments unless freshness or diagnostics make them relevant. Default true."),
		maxResults: maxResultsProperty,
		timeoutMs: timeoutProperty,
	}),
	mutates: false,
	run: async (params, env: CodeIntelEnv, signal?: AbortSignal) => {
		const roots = await resolveRepoRootsFromCwd(env.cwd, params.repoRoot);
		const effectiveParams = normalizeStandalonePathParams(params as unknown as Record<string, unknown>, env, roots.repoRoot) as unknown as CodeIntelPostEditMapParams;
		const payload = await runPostEditMap(effectiveParams, roots.repoRoot, env.config, signal, { persistentLsp: env.persistentLsp === true });
		if (roots.diagnostics.length > 0) payload.diagnostics = [...roots.diagnostics, ...(Array.isArray(payload.diagnostics) ? payload.diagnostics : [])];
		return { contentText: compactCodeIntelOutput("post_edit", payload), details: payload };
	},
};

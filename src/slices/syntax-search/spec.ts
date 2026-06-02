import { compactCodeIntelOutput } from "../../compact-output.ts";
import { resolveRepoRootsFromCwd } from "../../repo.ts";
import { detailProperty, maxResultsProperty, objectSchema, repoRootProperty, stringArrayParam, stringParam, timeoutProperty } from "../../standalone/schema.ts";
import type { CodeIntelEnv } from "../../standalone/env.ts";
import { normalizeStandalonePathParams } from "../../standalone/path-params.ts";
import type { CodeIntelToolSpec } from "../../tool-registry.ts";
import type { CodeIntelSyntaxSearchParams } from "../../types.ts";
import { runSyntaxSearch } from "./run.ts";

export const syntaxSearchToolSpec: CodeIntelToolSpec<CodeIntelSyntaxSearchParams> = {
	name: "code_intel_syntax_search",
	title: "Code Intelligence Syntax Search",
	description: "Run a read-only in-process Tree-sitter syntax search for explicit scoped shapes, with normalized candidate locations.",
	promptSnippet: "Use for narrow current-source syntax shapes that impact/local maps cannot express; read or edit matches with follow-up tools.",
	promptGuidelines: [
		"Provide a concrete pattern and language; scope paths/globs so results are useful and reviewable.",
		"Use supported ast-grep-style patterns such as foo($A), $OBJ.Field, Field: $VALUE, or wrapper patterns containing those shapes; advanced users can pass raw Tree-sitter S-expression queries.",
		"Use detail:'locations' when matches are read/edit targets; use snippets for quick relevance checks.",
		"Use this for candidate matching, API-shape checks, and pattern-specific review, then read or mutate selected targets with the appropriate tools.",
		"Inspect source and validate behavior before turning matches into findings or completion claims.",
	],
	inputSchema: objectSchema({
		repoRoot: repoRootProperty,
		pattern: stringParam("Explicit Tree-sitter query or supported ast-grep-style pattern, e.g. 'foo($A)', '$OBJ.Field', or 'Field: $VALUE'. Required and read-only."),
		language: stringParam("Tree-sitter language, e.g. ts, javascript, go, python, rust, c#, c++, or zsh. Markdown uses local-map document matching instead of syntax search."),
		paths: stringArrayParam("Repo-relative files or directories to search. Defaults to '.'. Paths outside the repo are rejected."),
		includeGlobs: stringArrayParam("Additional glob-like include patterns."),
		excludeGlobs: stringArrayParam("Additional glob-like exclude patterns. Leading '!' is optional."),
		selector: stringParam("Optional node kind or capture name to extract, e.g. selector_expression for Go field selections."),
		maxResults: maxResultsProperty,
		timeoutMs: timeoutProperty,
		strictness: { enum: ["cst", "smart", "ast", "relaxed", "signature", "template"], description: "Compatibility hint for ast-grep-style patterns; ignored by the in-process Tree-sitter runner." },
		detail: detailProperty,
	}, ["pattern"]),
	mutates: false,
	run: async (params, env: CodeIntelEnv, signal?: AbortSignal) => {
		const roots = await resolveRepoRootsFromCwd(env.cwd, params.repoRoot);
		const effectiveParams = normalizeStandalonePathParams(params as unknown as Record<string, unknown>, env, roots.repoRoot) as unknown as CodeIntelSyntaxSearchParams;
		const payload = await runSyntaxSearch(effectiveParams, roots.repoRoot, env.config, signal);
		if (roots.diagnostics.length > 0) payload.diagnostics = [...roots.diagnostics, ...(Array.isArray(payload.diagnostics) ? payload.diagnostics : [])];
		return { contentText: compactCodeIntelOutput("syntax", payload), details: payload };
	},
};

import { compactCodeIntelOutput } from "../../compact-output.ts";
import { resolveRepoRootsFromCwd } from "../../repo.ts";
import { booleanParam, detailProperty, maxResultsProperty, numberParam, objectSchema, repoRootProperty, stringArrayParam, stringParam, timeoutProperty } from "../../standalone/schema.ts";
import type { CodeIntelEnv } from "../../standalone/env.ts";
import { normalizeStandalonePathParams } from "../../standalone/path-params.ts";
import type { CodeIntelToolSpec } from "../../tool-registry.ts";
import type { CodeIntelLocalMapParams } from "../../types.ts";
import { runLocalMap } from "./run.ts";

export const localMapToolSpec: CodeIntelToolSpec<CodeIntelLocalMapParams> = {
	name: "code_intel_local_map",
	title: "Code Intelligence Local Map",
	description: "Build a scoped local read-next map from anchor names, related symbol/field names, optional path scope, Tree-sitter candidates, and bounded rg literal fallback.",
	promptSnippet: "Map a local subsystem into candidate files to read next from anchors plus related names.",
	promptGuidelines: [
		"Use code_intel_local_map when a scoped edit/review has a central anchor plus related fields/types/API terms and you need a candidate file list.",
		"Use it to answer: which local files should I read next, and why are they candidates?",
		"Provide anchors for central functions/types and names for related fields/types/API terms; add paths to keep the map local.",
		"Language aliases such as c#, c++, py, md/markdown, and zsh are normalized; Markdown uses heading/link/code-fence routing plus literal fallback rather than Tree-sitter syntax search.",
		"Use detail:'locations' for routing to files; use standalone rg afterward when you need comments/docs/generated text beyond the returned cap or unsupported-language gaps.",
	],
	inputSchema: objectSchema({
		repoRoot: repoRootProperty,
		anchors: stringArrayParam("Central function/type names that anchor the implementation area, e.g. lowerAggregation."),
		names: stringArrayParam("Related symbol, field, type, or API names to map, e.g. RequiredTagLabels."),
		paths: stringArrayParam("Repo-relative files or directories to keep the map local."),
		language: stringParam("Language for optional selector syntax/doc matches, e.g. go, ts, python, c#, c++, zsh, markdown."),
		includeSyntax: booleanParam("Run optional selector syntax matches like $X.Name when language is provided. Default true."),
		maxResults: maxResultsProperty,
		maxPerName: numberParam("Maximum refs/syntax/literal matches per name. Default min(config maxResults, 8)."),
		timeoutMs: timeoutProperty,
		detail: detailProperty,
	}),
	mutates: false,
	run: async (params, env: CodeIntelEnv, signal?: AbortSignal) => {
		const roots = await resolveRepoRootsFromCwd(env.cwd, params.repoRoot);
		const effectiveParams = normalizeStandalonePathParams(params as unknown as Record<string, unknown>, env, roots.repoRoot) as unknown as CodeIntelLocalMapParams;
		const payload = await runLocalMap(effectiveParams, roots.repoRoot, env.config, signal);
		if (roots.diagnostics.length > 0) payload.diagnostics = [...roots.diagnostics, ...(Array.isArray(payload.diagnostics) ? payload.diagnostics : [])];
		return { contentText: compactCodeIntelOutput("local", payload), details: payload };
	},
};

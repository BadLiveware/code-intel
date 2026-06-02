import { compactCodeIntelOutput } from "../../compact-output.ts";
import { resolveRepoRootsFromCwd } from "../../repo.ts";
import { booleanParam, objectSchema, recordParam, repoRootProperty, stringParam, timeoutProperty } from "../../standalone/schema.ts";
import type { CodeIntelEnv } from "../../standalone/env.ts";
import { normalizeStandalonePathParams } from "../../standalone/path-params.ts";
import type { CodeIntelToolSpec } from "../../tool-registry.ts";
import type { CodeIntelInsertRelativeParams, CodeIntelReplaceSymbolParams } from "../../types.ts";
import { runInsertRelative, runReplaceSymbol } from "./run.ts";

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
	rangeId: stringParam("Exact range id emitted by locator-mode code-intel tools."),
};

export const replaceSymbolToolSpec: CodeIntelToolSpec<CodeIntelReplaceSymbolParams> = {
	name: "code_intel_replace_symbol",
	title: "Code Intelligence Replace Symbol",
	description: "Replace the current text of a resolved symbolTarget after verifying oldText or oldHash safety evidence. Disabled in standalone mode unless mutations are explicitly enabled.",
	promptSnippet: "Use when you already have a code-intel symbolTarget and need to replace that exact declaration without reconstructing line numbers after edits.",
	promptGuidelines: [
		"Prefer code_intel_replace_symbol for declaration-sized replacements when you have a symbolTarget from code_intel_read_symbol or code_intel_file_outline.",
		"Provide oldHash from code_intel_read_symbol for token-light safety, or oldText when exact reviewable replacement evidence is useful. If both are supplied, both must match.",
		"After the anchored mutation, use code_intel_post_edit_map or project validation when you need changed-symbol, caller, test, or diagnostic follow-up context.",
	],
	inputSchema: objectSchema({
		...selectorProperties,
		oldText: stringParam("Exact expected current symbol text. If provided, it must match after fresh resolution."),
		oldHash: stringParam("Hash of the exact expected current symbol text, e.g. oldHash from code_intel_read_symbol."),
		newText: stringParam("Replacement text for the resolved symbol range."),
		normalizeEol: booleanParam("Normalize newText line endings to the target file style. Default true."),
		timeoutMs: timeoutProperty,
	}, ["newText"]),
	mutates: true,
	run: async (params, env: CodeIntelEnv, signal?: AbortSignal) => {
		const roots = await resolveRepoRootsFromCwd(env.cwd, params.repoRoot);
		const effectiveParams = normalizeStandalonePathParams(params as unknown as Record<string, unknown>, env, roots.repoRoot) as unknown as CodeIntelReplaceSymbolParams;
		const payload = await runReplaceSymbol(effectiveParams, roots.repoRoot, env.config, signal);
		if (roots.diagnostics.length > 0) payload.diagnostics = [...roots.diagnostics, ...(Array.isArray(payload.diagnostics) ? payload.diagnostics : [])];
		return { contentText: compactCodeIntelOutput("replace_symbol", payload), details: payload };
	},
};

export const insertRelativeToolSpec: CodeIntelToolSpec<CodeIntelInsertRelativeParams> = {
	name: "code_intel_insert_relative",
	title: "Code Intelligence Insert Relative",
	description: "Insert text before or after a resolved symbolTarget anchor, using the same stale-target resolution as read_symbol. Disabled in standalone mode unless mutations are explicitly enabled.",
	promptSnippet: "Use with a symbolTarget from file outline or read_symbol to add a declaration before/after an existing symbol without reading the whole file.",
	promptGuidelines: [
		"Prefer code_intel_insert_relative for adding declarations or sections next to a resolved anchor from code_intel_file_outline or code_intel_read_symbol.",
		"Use code_intel_read_symbol first when the inserted code depends on the anchor body; provide anchorHash when compact safety evidence from a prior read helps.",
		"After the anchored insertion, use code_intel_post_edit_map or project validation when you need changed-symbol, caller, test, or diagnostic follow-up context.",
	],
	inputSchema: objectSchema({
		...selectorProperties,
		anchor: recordParam("Symbol target object to insert before/after. Usually from file outline or read_symbol."),
		position: { enum: ["before", "after"], description: "Insert before or after the resolved anchor symbol." },
		text: stringParam("Text to insert relative to the resolved anchor. A trailing newline is added when needed to avoid merging with following text."),
		anchorHash: stringParam("Hash of the exact expected current anchor text, e.g. oldHash from code_intel_read_symbol."),
		normalizeEol: booleanParam("Normalize inserted text line endings to the target file style. Default true."),
		timeoutMs: timeoutProperty,
	}, ["position", "text"]),
	mutates: true,
	run: async (params, env: CodeIntelEnv, signal?: AbortSignal) => {
		const roots = await resolveRepoRootsFromCwd(env.cwd, params.repoRoot);
		const effectiveParams = normalizeStandalonePathParams(params as unknown as Record<string, unknown>, env, roots.repoRoot) as unknown as CodeIntelInsertRelativeParams;
		const payload = await runInsertRelative(effectiveParams, roots.repoRoot, env.config, signal);
		if (roots.diagnostics.length > 0) payload.diagnostics = [...roots.diagnostics, ...(Array.isArray(payload.diagnostics) ? payload.diagnostics : [])];
		return { contentText: compactCodeIntelOutput("insert_relative", payload), details: payload };
	},
};

import type { CodeIntelEnv } from "./standalone/env.ts";
import { impactMapToolSpec } from "./slices/impact-map/spec.ts";
import { localMapToolSpec } from "./slices/local-map/spec.ts";
import { fileOutlineToolSpec, repoOverviewToolSpec, repoRouteToolSpec, testMapToolSpec } from "./slices/orientation/specs.ts";
import { stateToolSpec } from "./slices/state/spec.ts";
import { insertRelativeToolSpec, replaceSymbolToolSpec } from "./slices/symbol-mutations/specs.ts";
import { syntaxSearchToolSpec } from "./slices/syntax-search/spec.ts";
import { postEditMapToolSpec, readSymbolToolSpec } from "./slices/targeted-symbols/specs.ts";

export interface JsonObjectSchema {
	type: "object";
	properties?: Record<string, unknown>;
	required?: string[];
	additionalProperties?: boolean;
	[key: string]: unknown;
}

export interface CodeIntelToolResult {
	contentText: string;
	details: Record<string, unknown>;
}

export interface CodeIntelToolSpec<P = Record<string, unknown>> {
	name: string;
	title: string;
	description: string;
	promptSnippet?: string;
	promptGuidelines: string[];
	inputSchema: JsonObjectSchema;
	mutates: boolean;
	run(params: P, env: CodeIntelEnv, signal?: AbortSignal): Promise<CodeIntelToolResult>;
}

const toolSpecs = [
	stateToolSpec,
	repoOverviewToolSpec,
	fileOutlineToolSpec,
	repoRouteToolSpec,
	testMapToolSpec,
	impactMapToolSpec,
	localMapToolSpec,
	syntaxSearchToolSpec,
	readSymbolToolSpec,
	postEditMapToolSpec,
	replaceSymbolToolSpec,
	insertRelativeToolSpec,
] as const satisfies readonly CodeIntelToolSpec<any>[];

export function listCodeIntelToolSpecs(options: { includeMutations?: boolean } = {}): CodeIntelToolSpec<any>[] {
	return toolSpecs.filter((spec) => options.includeMutations === true || !spec.mutates);
}

export function codeIntelToolSpec(name: string, options: { includeMutations?: boolean } = {}): CodeIntelToolSpec<any> | undefined {
	return listCodeIntelToolSpecs(options).find((spec) => spec.name === name);
}

export async function runCodeIntelTool(name: string, params: Record<string, unknown>, env: CodeIntelEnv, signal?: AbortSignal): Promise<CodeIntelToolResult> {
	const spec = codeIntelToolSpec(name, { includeMutations: env.mutationPolicy === "enabled" });
	if (!spec) throw new Error(`Unknown or unavailable code-intel tool: ${name}`);
	if (spec.mutates && env.mutationPolicy !== "enabled") throw new Error(`Code-intel tool ${name} is disabled because mutationPolicy is disabled`);
	return await spec.run(params, env, signal);
}

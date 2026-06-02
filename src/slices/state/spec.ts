import { compactCodeIntelOutput } from "../../compact-output.ts";
import { resolveRepoRootsFromCwd } from "../../repo.ts";
import { booleanParam, objectSchema, repoRootProperty } from "../../standalone/schema.ts";
import type { CodeIntelEnv } from "../../standalone/env.ts";
import type { CodeIntelToolSpec } from "../../tool-registry.ts";
import type { CodeIntelStateParams, LoadedConfig } from "../../types.ts";
import { languageServerStatusesFromProviders, semanticProviderStatuses } from "../../lsp/provider-status.ts";
import { backendStatuses, statePayload } from "./run.ts";

function loadedConfigFromEnv(env: CodeIntelEnv): LoadedConfig {
	return {
		config: env.config,
		paths: { user: env.configPaths.user, project: env.configPaths.project },
		loaded: env.loadedConfig,
		diagnostics: env.configDiagnostics,
	};
}

export const stateToolSpec: CodeIntelToolSpec<CodeIntelStateParams> = {
	name: "code_intel_state",
	title: "Code Intelligence State",
	description: "Inspect local Tree-sitter parser, rg fallback, optional language-server availability, config, and runtime diagnostics.",
	promptSnippet: "Inspect code-intel status before debugging parser availability, rg fallback, config, or footer errors.",
	promptGuidelines: [
		"Use code-intel tools as owned read-next and symbol-targeting helpers whenever they fit the code task; use source reads and validation to turn routing evidence into claims.",
		"Start normal code-intel work from code_intel_impact_map for diffs/changed symbols or code_intel_local_map for a scoped subsystem; both are Tree-sitter/current-source first.",
		"Use rg fallback rows for literal text, comments/docs, generated files, or unsupported-language gaps.",
		"Use includeDiagnostics:true when parser availability, rg fallback, config, footer errors, or failed probes matter to the next move.",
	],
	inputSchema: objectSchema({
		repoRoot: repoRootProperty,
		includeDiagnostics: booleanParam("Include config diagnostics and recent runtime errors. Default false; use for debugging failures, not routine freshness checks."),
	}),
	mutates: false,
	run: async (params, env: CodeIntelEnv) => {
		const roots = await resolveRepoRootsFromCwd(env.cwd, params.repoRoot);
		const [statuses, semanticProviders] = await Promise.all([backendStatuses(roots.repoRoot, env.config), semanticProviderStatuses(roots.repoRoot, env.config)]);
		const languageServers = languageServerStatusesFromProviders(semanticProviders);
		const payload = statePayload(roots, loadedConfigFromEnv(env), statuses, params.includeDiagnostics === true, languageServers, semanticProviders) as Record<string, unknown>;
		return { contentText: compactCodeIntelOutput("state", payload), details: payload };
	},
};

import { compactCodeIntelOutput } from "../../compact-output.ts";
import { resolveRepoRootsFromCwd } from "../../repo.ts";
import type { CodeIntelImpactMapParams } from "../../types.ts";
import type { CodeIntelToolSpec, JsonObjectSchema } from "../../tool-registry.ts";
import type { CodeIntelEnv } from "../../standalone/env.ts";
import { normalizeStandalonePathParams } from "../../standalone/path-params.ts";
import { runImpactMap } from "./run.ts";

const stringArraySchema = (description: string): Record<string, unknown> => ({ type: "array", items: { type: "string" }, description });
const numberSchema = (description: string): Record<string, unknown> => ({ type: "number", description });

export const impactMapInputSchema = {
	type: "object",
	properties: {
		repoRoot: { type: "string", description: "Repository or directory to inspect. Defaults to the current working directory." },
		symbols: stringArraySchema("Symbols to treat as impact roots."),
		changedFiles: stringArraySchema("Repo-relative files whose defined symbols should be impact roots."),
		baseRef: { type: "string", description: "Optional git base ref for discovering changed files with git diff --name-only." },
		maxResults: numberSchema("Maximum related rows returned. Defaults to min(config maxResults, 125) for locations, or min(config maxResults, 25) for snippets."),
		maxRootSymbols: numberSchema("Maximum root symbols to query after expanding changed files. Default 20."),
		timeoutMs: numberSchema("Command timeout in milliseconds. Defaults to config queryTimeoutMs."),
		detail: { enum: ["locations", "snippets"], description: "Output detail. Use 'locations' when you plan to read/edit returned files; use 'snippets' for small inline context." },
		confirmReferences: { enum: ["gopls", "typescript", "clangd", "rust-analyzer", "csharp-ls", "pyrefly"], description: "Opt-in exact-reference confirmation for returned roots using gopls, the TypeScript language service, clangd for C/C++ with compile_commands.json, Rust Analyzer, csharp-ls, or Pyrefly for Python." },
		maxReferenceRoots: numberSchema("Maximum roots to confirm when confirmReferences is set. Default 5."),
		maxReferenceResults: numberSchema("Maximum reference rows returned when confirmReferences is set. Default min(config maxResults, 25)."),
		includeReferenceDeclarations: { type: "boolean", description: "Include declarations in reference-confirmation output. Default false." },
	},
	additionalProperties: false,
} as const satisfies JsonObjectSchema;

export const impactMapPromptGuidelines = [
	"Use code_intel_impact_map as the default code-intel tool after seeing a diff or before editing exported functions/types, handlers, config/schema/protocol behavior, shared helpers, or multiple files.",
	"Use it to answer: which unchanged caller, consumer, or test files should I read before changing or reviewing this code, and what evidence made them candidates?",
	"Rows like syntax_call, syntax_selector, and syntax_keyed_field are current-source Tree-sitter candidates with real locations; read candidates and use confirmReferences when exactness matters.",
	"Start with symbols, changedFiles, or baseRef; inspect rootSymbols, related rows, coverage, truncation, and limitations.",
	"If the map is empty or ok:false, use reason plus coverage.supportedImpactLanguages, unsupportedImpactFiles, docFiles, and nonSourceFiles to choose syntax search, source reads, or bounded rg fallback.",
	"Use detail:'locations' for routing to files; use detail:'snippets' when inline context helps avoid extra reads.",
	"Use impact maps as the candidate read list for caller, consumer, test, and compatibility inspection.",
	"Use confirmReferences when exact-reference confirmation is worth the extra bounded provider call.",
	"When delegating review, run this in the parent and pass candidate files/reasons to subagents, or choose a code-intel-aware subagent that can run it directly.",
];

export async function runImpactMapTool(params: CodeIntelImpactMapParams, env: CodeIntelEnv, signal?: AbortSignal) {
	const roots = await resolveRepoRootsFromCwd(env.cwd, params.repoRoot);
	const effectiveParams = normalizeStandalonePathParams(params as unknown as Record<string, unknown>, env, roots.repoRoot) as unknown as CodeIntelImpactMapParams;
	const payload = await runImpactMap(effectiveParams, roots.repoRoot, env.config, signal);
	if (roots.diagnostics.length > 0) {
		payload.diagnostics = [...roots.diagnostics, ...(Array.isArray(payload.diagnostics) ? payload.diagnostics : [])];
	}
	return {
		contentText: compactCodeIntelOutput("impact", payload),
		details: payload,
	};
}

export const impactMapToolSpec: CodeIntelToolSpec<CodeIntelImpactMapParams> = {
	name: "code_intel_impact_map",
	title: "Code Intelligence Impact Map",
	description: "Build the primary Tree-sitter read-next impact map from edited files, queried symbols, or a git base ref. Code impact routing follows the language registry; Markdown changes are reported as documentation files rather than code impact.",
	promptSnippet: "Primary code-intel entry point: list candidate caller/consumer/test files to read before edits or reviews.",
	promptGuidelines: impactMapPromptGuidelines,
	inputSchema: impactMapInputSchema,
	mutates: false,
	run: runImpactMapTool,
};

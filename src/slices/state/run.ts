import { createRequire } from "node:module";
import type { BackendName, BackendStatus, CodeIntelConfig, LanguageServerName, LanguageServerStatus, LoadedConfig, RepoRoots } from "../../types.ts";
import { commandDiagnostic, findExecutable, firstLine, runCommand } from "../../exec.ts";
import { IMPACT_LANGUAGE_IDS, LANGUAGE_SPECS, languageCapabilitySummary } from "../../languages.ts";
import { languageServerStatusesFromProviders, legacyLanguageServerSemanticProviderStatuses, semanticProviderStatuses } from "../../lsp/provider-status.ts";

function treeSitterStatus(): BackendStatus {
	try {
		const require = createRequire(import.meta.url);
		const packageJson = require("@vscode/tree-sitter-wasm/package.json") as { version?: string };
		return {
			backend: "tree-sitter",
			available: "available",
			version: packageJson.version,
			indexStatus: "not-required",
			writesToRepo: false,
			artifacts: [],
			diagnostics: [],
			details: { runtime: "@vscode/tree-sitter-wasm", languages: LANGUAGE_SPECS.map((spec) => spec.id) },
		};
	} catch (error) {
		return {
			backend: "tree-sitter",
			available: "error",
			indexStatus: "error",
			writesToRepo: false,
			artifacts: [],
			diagnostics: [error instanceof Error ? error.message : String(error)],
		};
	}
}

async function rgStatus(repoRoot: string, config: CodeIntelConfig): Promise<BackendStatus> {
	const executable = findExecutable("rg");
	if (!executable) {
		return { backend: "rg", available: "missing", indexStatus: "not-required", writesToRepo: false, artifacts: [], diagnostics: ["rg not found on PATH"] };
	}
	const result = await runCommand(executable, ["--version"], { cwd: repoRoot, timeoutMs: Math.min(config.queryTimeoutMs, 10_000), maxOutputBytes: config.maxOutputBytes });
	const diagnostic = commandDiagnostic(result);
	return {
		backend: "rg",
		available: diagnostic ? "error" : "available",
		executable,
		version: firstLine(result.stdout || result.stderr),
		indexStatus: diagnostic ? "error" : "not-required",
		writesToRepo: false,
		artifacts: [],
		diagnostics: diagnostic ? [diagnostic] : [],
	};
}

export async function languageServerStatuses(repoRoot: string, config: CodeIntelConfig): Promise<Record<LanguageServerName, LanguageServerStatus>> {
	const providers = await legacyLanguageServerSemanticProviderStatuses(repoRoot, config);
	return languageServerStatusesFromProviders(providers);
}

export async function backendStatuses(repoRoot: string, config: CodeIntelConfig): Promise<Record<BackendName, BackendStatus>> {
	const rg = await rgStatus(repoRoot, config);
	return { "tree-sitter": treeSitterStatus(), rg };
}

export function statePayload(roots: RepoRoots, loadedConfig: LoadedConfig, statuses: Record<BackendName, BackendStatus>, includeDiagnostics: boolean, languageServers?: Record<LanguageServerName, LanguageServerStatus>, semanticProviders?: Awaited<ReturnType<typeof semanticProviderStatuses>>): Record<string, unknown> {
	const payload: Record<string, unknown> = {
		repoRoot: roots.repoRoot,
		requestedRoot: roots.requestedRoot,
		config: loadedConfig.config,
		configPaths: loadedConfig.paths,
		loadedConfig: loadedConfig.loaded,
		backends: statuses,
		languages: languageCapabilitySummary(),
		limitations: [
			"Use Tree-sitter rows as current-source read-next routing with real locations, then read selected source for claims or edits.",
			"Use rg literal fallback for text discovery in comments, docs, fixtures, generated files, and unsupported-language gaps.",
			`Impact maps currently route ${IMPACT_LANGUAGE_IDS.join(", ")}; use returned coverage fields to choose follow-up source reads, syntax searches, or fallback searches.`,
			"Use language-server status to decide when opt-in reference confirmation or post-edit touched-file diagnostics are available.",
		],
	};
	if (languageServers) payload.languageServers = languageServers;
	if (semanticProviders) payload.semanticProviders = semanticProviders;
	if (includeDiagnostics) {
		payload.diagnostics = [
			...roots.diagnostics,
			...loadedConfig.diagnostics,
			...Object.values(statuses).flatMap((status) => status.diagnostics),
			...(semanticProviders ? Object.values(semanticProviders).flatMap((status) => status.diagnostics) : Object.values(languageServers ?? {}).flatMap((status) => status.diagnostics)),
		];
	}
	return payload;
}

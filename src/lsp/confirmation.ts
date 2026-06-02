import type { CodeIntelConfig } from "../types.ts";
import { isRecord, normalizePositiveInteger, summarizeFileDistribution } from "../util.ts";
import { clangdReferenceProvider } from "./providers/clangd-lsp.ts";
import { csharpLsReferenceProvider } from "./providers/csharp-ls-lsp.ts";
import { goplsReferenceProvider } from "./providers/gopls-command.ts";
import { pyreflyReferenceProvider } from "./providers/pyrefly-lsp.ts";
import { rustAnalyzerReferenceProvider } from "./providers/rust-analyzer-lsp.ts";
import { typescriptReferenceProvider } from "./providers/typescript-language-service.ts";
import type { ReferenceConfirmationOptions, ReferenceConfirmationProvider, ReferenceConfirmationProviderName, ReferenceRoot } from "./types.ts";

const providers: Record<ReferenceConfirmationProviderName, ReferenceConfirmationProvider> = {
	gopls: goplsReferenceProvider,
	typescript: typescriptReferenceProvider,
	clangd: clangdReferenceProvider,
	"rust-analyzer": rustAnalyzerReferenceProvider,
	"csharp-ls": csharpLsReferenceProvider,
	pyrefly: pyreflyReferenceProvider,
};

function asRoot(value: unknown): ReferenceRoot | undefined {
	if (!isRecord(value)) return undefined;
	const name = typeof value.name === "string" ? value.name : typeof value.symbol === "string" ? value.symbol : undefined;
	const file = typeof value.file === "string" ? value.file : undefined;
	const line = typeof value.line === "number" ? value.line : undefined;
	if (!name || !file || !line || line <= 0) return undefined;
	return {
		name,
		file,
		line,
		column: typeof value.column === "number" && value.column > 0 ? value.column : 1,
		language: typeof value.language === "string" ? value.language : undefined,
		kind: typeof value.kind === "string" ? value.kind : undefined,
	};
}

function emptyConfirmation(provider: ReferenceConfirmationProvider, started: number, diagnostics: string[]): Record<string, unknown> {
	return {
		ok: false,
		backend: provider.name,
		basis: "lspExactReferences",
		references: [],
		diagnostics,
		limitations: provider.limitations,
		elapsedMs: Date.now() - started,
	};
}

export async function runReferenceConfirmation(providerName: ReferenceConfirmationProviderName, roots: unknown[], repoRoot: string, options: ReferenceConfirmationOptions, config: CodeIntelConfig, signal?: AbortSignal): Promise<Record<string, unknown>> {
	const started = Date.now();
	const provider = providers[providerName];
	const maxRoots = normalizePositiveInteger(options.maxRoots, 5, 1, 50);
	const maxResults = normalizePositiveInteger(options.maxResults, Math.min(config.maxResults, 25), 1, 500);
	const timeoutMs = normalizePositiveInteger(options.timeoutMs, config.queryTimeoutMs, 1_000, 600_000);
	const candidateRoots = roots
		.map(asRoot)
		.filter((root): root is ReferenceRoot => root !== undefined && (root.language === undefined || provider.supportedLanguages.includes(root.language)));
	const rootsToConfirm = candidateRoots.slice(0, maxRoots);
	if (rootsToConfirm.length === 0) return emptyConfirmation(provider, started, [provider.noRootsDiagnostic]);

	const result = await provider.confirmRoots(rootsToConfirm, { repoRoot, config, signal }, options, { maxRoots, maxResults, timeoutMs });
	return {
		ok: result.diagnostics.length === 0,
		backend: provider.name,
		basis: "lspExactReferences",
		evidence: provider.evidence,
		executable: result.executable,
		version: result.version,
		workspaceRoot: result.workspaceRoot,
		session: result.session,
		includeDeclarations: options.includeDeclarations === true,
		roots: result.roots,
		references: result.references,
		summary: {
			rootCount: result.roots.length,
			referenceCount: result.references.length,
			...summarizeFileDistribution(result.references),
		},
		coverage: {
			candidateRoots: candidateRoots.length,
			maxRoots,
			maxResults,
			truncated: candidateRoots.length > result.roots.length || result.references.length >= maxResults,
		},
		diagnostics: result.diagnostics,
		limitations: result.limitations ?? provider.limitations,
		elapsedMs: Date.now() - started,
	};
}

import type { Availability, CodeIntelConfig, LanguageServerName } from "../types.ts";

export type ReferenceConfirmationProviderName = "gopls" | "typescript" | "clangd" | "rust-analyzer" | "csharp-ls" | "pyrefly";
export type SemanticProviderName = ReferenceConfirmationProviderName | "ty" | "pyright" | "basedpyright" | "jedi" | "shellcheck" | "zsh" | "markdownlint-cli2";
export type SemanticProviderCapabilityState = "implemented" | "planned" | "none";

export interface SemanticProviderMetadata {
	name: SemanticProviderName;
	label: string;
	supportedLanguages: string[];
	command?: string;
	commands?: string[];
	packageName?: string;
	versionArgs?: string[];
	capabilities: {
		references: SemanticProviderCapabilityState;
		diagnostics: SemanticProviderCapabilityState;
	};
	evidence: {
		references?: string;
		diagnostics?: string;
	};
	missingDiagnostic: string;
	noRootsDiagnostic?: string;
	workspacePrerequisites?: string[];
	limitations: string[];
	legacyLanguageServer?: LanguageServerName;
	statusKind?: "typescript";
}

export interface SemanticProviderStatus {
	provider: SemanticProviderName;
	label: string;
	available: Availability;
	executable?: string;
	version?: string;
	diagnostics: string[];
	details: {
		supportedLanguages: string[];
		capabilities: SemanticProviderMetadata["capabilities"];
		evidence: SemanticProviderMetadata["evidence"];
		commands?: string[];
		command?: string;
		packageName?: string;
		workspacePrerequisites?: string[];
		limitations: string[];
		[key: string]: unknown;
	};
}

export interface ReferenceRoot {
	name: string;
	file: string;
	line: number;
	column: number;
	language?: string;
	kind?: string;
}

export interface ReferenceConfirmationOptions {
	maxRoots?: number;
	maxResults?: number;
	timeoutMs?: number;
	includeDeclarations?: boolean;
	persistentLsp?: boolean;
}

export interface ReferenceConfirmationLimits {
	maxRoots: number;
	maxResults: number;
	timeoutMs: number;
}

export interface ReferenceConfirmationContext {
	repoRoot: string;
	config: CodeIntelConfig;
	signal?: AbortSignal;
}

export interface ReferenceConfirmationProviderResult {
	executable?: string;
	version?: string;
	workspaceRoot?: string;
	session?: Record<string, unknown>;
	roots: Record<string, unknown>[];
	references: Record<string, unknown>[];
	diagnostics: string[];
	limitations?: string[];
}

export interface ReferenceConfirmationProvider {
	name: ReferenceConfirmationProviderName;
	evidence: string;
	supportedLanguages: string[];
	missingDiagnostic: string;
	noRootsDiagnostic: string;
	limitations: string[];
	confirmRoots(roots: ReferenceRoot[], context: ReferenceConfirmationContext, options: ReferenceConfirmationOptions, limits: ReferenceConfirmationLimits): Promise<ReferenceConfirmationProviderResult>;
}

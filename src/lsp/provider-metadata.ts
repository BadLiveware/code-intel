import type { LanguageServerName } from "../types.ts";
import type { ReferenceConfirmationProviderName, SemanticProviderCapabilityState, SemanticProviderMetadata, SemanticProviderName } from "./types.ts";

function capabilities(references: SemanticProviderCapabilityState, diagnostics: SemanticProviderCapabilityState): SemanticProviderMetadata["capabilities"] {
	return { references, diagnostics };
}

export const SEMANTIC_PROVIDER_METADATA: SemanticProviderMetadata[] = [
	{
		name: "gopls",
		label: "Go gopls",
		supportedLanguages: ["go"],
		command: "gopls",
		versionArgs: ["version"],
		capabilities: capabilities("implemented", "implemented"),
		evidence: { references: "gopls:references", diagnostics: "gopls:check" },
		missingDiagnostic: "gopls not found on PATH",
		noRootsDiagnostic: "No Go roots with current-source definition locations were available for gopls confirmation.",
		limitations: [
			"gopls confirmation is opt-in and only runs for Go roots with current-source definition locations.",
			"The default routing map remains Tree-sitter syntax evidence; read the returned files before making compatibility or defect claims.",
		],
		legacyLanguageServer: "gopls",
	},
	{
		name: "typescript",
		label: "TypeScript language service",
		supportedLanguages: ["typescript", "tsx", "javascript"],
		packageName: "typescript",
		commands: ["tsserver", "typescript-language-server"],
		versionArgs: ["--version"],
		capabilities: capabilities("implemented", "implemented"),
		evidence: { references: "typescript:references", diagnostics: "typescript-language-service-diagnostics" },
		missingDiagnostic: "typescript package not available to code-intelligence extension",
		noRootsDiagnostic: "No TypeScript/JavaScript roots with current-source definition locations were available for TypeScript reference confirmation.",
		limitations: [
			"TypeScript confirmation is opt-in and uses the local TypeScript language service for current workspace files.",
			"TypeScript diagnostics are current touched-file diagnostics unless a future baseline marks rows as new.",
			"The default routing map remains Tree-sitter syntax evidence; read the returned files before making compatibility or defect claims.",
		],
		legacyLanguageServer: "typescript",
		statusKind: "typescript",
	},
	{
		name: "clangd",
		label: "clangd",
		supportedLanguages: ["cpp"],
		command: "clangd",
		versionArgs: ["--version"],
		capabilities: capabilities("implemented", "implemented"),
		evidence: { references: "clangd:textDocument/references", diagnostics: "clangd:publishDiagnostics" },
		missingDiagnostic: "clangd not found on PATH",
		noRootsDiagnostic: "No C/C++ roots with current-source definition locations were available for clangd confirmation.",
		workspacePrerequisites: ["compile_commands.json"],
		limitations: [
			"clangd confirmation is opt-in and only runs for C/C++ roots with current-source definition locations.",
			"clangd diagnostics are current touched-file diagnostics unless a future baseline marks rows as new.",
			"clangd requires a usable compile_commands.json; missing or stale compile databases make provider results unavailable or incomplete.",
			"The default routing map remains Tree-sitter syntax evidence; read the returned files before making compatibility or defect claims.",
		],
		legacyLanguageServer: "clangd",
	},
	{
		name: "rust-analyzer",
		label: "Rust Analyzer",
		supportedLanguages: ["rust"],
		command: "rust-analyzer",
		versionArgs: ["--version"],
		capabilities: capabilities("implemented", "implemented"),
		evidence: { references: "rust-analyzer:textDocument/references", diagnostics: "rust-analyzer:publishDiagnostics" },
		missingDiagnostic: "rust-analyzer not found on PATH",
		noRootsDiagnostic: "No Rust roots with current-source definition locations were available for Rust Analyzer confirmation.",
		workspacePrerequisites: ["Cargo.toml workspace discovery"],
		limitations: [
			"Rust Analyzer confirmation is opt-in and only runs for Rust roots with current-source definition locations.",
			"Rust Analyzer diagnostics are current touched-file diagnostics unless a future baseline marks rows as new.",
			"The default Rust routing map remains Tree-sitter syntax evidence and does not require Rust Analyzer.",
		],
		legacyLanguageServer: "rust-analyzer",
	},
	{
		name: "pyrefly",
		label: "Pyrefly",
		supportedLanguages: ["python"],
		command: "pyrefly",
		versionArgs: ["--version"],
		capabilities: capabilities("implemented", "implemented"),
		evidence: { references: "pyrefly:textDocument/references", diagnostics: "pyrefly:check-json" },
		missingDiagnostic: "pyrefly not found on PATH",
		noRootsDiagnostic: "No Python roots with current-source definition locations were available for Pyrefly confirmation.",
		limitations: [
			"Pyrefly confirmation is opt-in and only runs for Python roots with current-source definition locations.",
			"Pyrefly diagnostics are preferred for Python touched-file diagnostics when available.",
			"The default Python routing map remains Tree-sitter syntax evidence and does not require Pyrefly.",
		],
	},
	{
		name: "ty",
		label: "ty",
		supportedLanguages: ["python"],
		command: "ty",
		versionArgs: ["version"],
		capabilities: capabilities("planned", "implemented"),
		evidence: { references: "ty:textDocument/references", diagnostics: "ty:check-gitlab" },
		missingDiagnostic: "ty not found on PATH",
		limitations: [
			"ty diagnostics are used as the second-choice Python provider because its documented CLI JSON surface is the GitLab code-quality output format.",
			"ty server is a non-default Python reference alternative and is not exposed in confirmReferences yet.",
		],
	},
	{
		name: "basedpyright",
		label: "basedpyright",
		supportedLanguages: ["python"],
		command: "basedpyright",
		versionArgs: ["--version"],
		capabilities: capabilities("none", "implemented"),
		evidence: { diagnostics: "basedpyright:outputjson" },
		missingDiagnostic: "basedpyright not found on PATH",
		limitations: ["basedpyright is a fallback Python diagnostics provider; exact references are not planned for this command."],
	},
	{
		name: "pyright",
		label: "Pyright",
		supportedLanguages: ["python"],
		command: "pyright",
		versionArgs: ["--version"],
		capabilities: capabilities("planned", "implemented"),
		evidence: { references: "pyright:textDocument/references", diagnostics: "pyright:outputjson" },
		missingDiagnostic: "pyright not found on PATH",
		limitations: [
			"Pyright diagnostics remain a Python fallback provider after Pyrefly, ty, and basedpyright.",
			"Pyright reference confirmation is a non-default Python alternative and is not exposed in confirmReferences yet.",
		],
	},
	{
		name: "jedi",
		label: "jedi-language-server",
		supportedLanguages: ["python"],
		command: "jedi-language-server",
		versionArgs: ["--version"],
		capabilities: capabilities("planned", "none"),
		evidence: { references: "jedi:textDocument/references" },
		missingDiagnostic: "jedi-language-server not found on PATH",
		limitations: ["Jedi reference confirmation is a non-default Python alternative and is not exposed in confirmReferences yet."],
	},
	{
		name: "csharp-ls",
		label: "csharp-ls",
		supportedLanguages: ["csharp"],
		command: "csharp-ls",
		versionArgs: ["--version"],
		capabilities: capabilities("implemented", "implemented"),
		evidence: { references: "csharp-ls:textDocument/references", diagnostics: "csharp-ls:publishDiagnostics" },
		missingDiagnostic: "csharp-ls not found on PATH",
		noRootsDiagnostic: "No C# roots with current-source definition locations were available for csharp-ls confirmation.",
		workspacePrerequisites: [".sln or .csproj workspace discovery"],
		limitations: [
			"csharp-ls confirmation is opt-in and only runs for C# roots with current-source definition locations.",
			"csharp-ls diagnostics are current touched-file diagnostics unless a future baseline marks rows as new.",
			"The default C# routing map remains Tree-sitter syntax evidence and does not require csharp-ls.",
		],
	},
	{
		name: "shellcheck",
		label: "ShellCheck",
		supportedLanguages: ["bash"],
		command: "shellcheck",
		versionArgs: ["--version"],
		capabilities: capabilities("none", "implemented"),
		evidence: { diagnostics: "shellcheck:json" },
		missingDiagnostic: "shellcheck not found on PATH",
		limitations: ["ShellCheck diagnostics run only for touched sh/bash files; zsh files use a separate syntax-only provider."],
	},
	{
		name: "zsh",
		label: "zsh -n",
		supportedLanguages: ["zsh"],
		command: "zsh",
		versionArgs: ["--version"],
		capabilities: capabilities("none", "implemented"),
		evidence: { diagnostics: "zsh -n" },
		missingDiagnostic: "zsh not found on PATH",
		limitations: ["zsh diagnostics are syntax-only touched-file checks; they do not prove runtime behavior."],
	},
	{
		name: "markdownlint-cli2",
		label: "markdownlint-cli2",
		supportedLanguages: ["markdown"],
		command: "markdownlint-cli2",
		versionArgs: ["--version"],
		capabilities: capabilities("none", "implemented"),
		evidence: { diagnostics: "markdownlint-cli2:json" },
		missingDiagnostic: "markdownlint-cli2 not found on PATH",
		limitations: ["Markdown diagnostics run only for touched Markdown files; link checks remain explicit and non-default."],
	},
];

const metadataByName = new Map(SEMANTIC_PROVIDER_METADATA.map((provider) => [provider.name, provider]));

export function semanticProviderMetadata(name: SemanticProviderName): SemanticProviderMetadata {
	const metadata = metadataByName.get(name);
	if (!metadata) throw new Error(`Unknown semantic provider metadata: ${name}`);
	return metadata;
}

export function referenceProviderMetadata(name: ReferenceConfirmationProviderName): SemanticProviderMetadata {
	return semanticProviderMetadata(name);
}

export function languageServerProviderMetadata(): Array<SemanticProviderMetadata & { legacyLanguageServer: LanguageServerName }> {
	return SEMANTIC_PROVIDER_METADATA.filter((provider): provider is SemanticProviderMetadata & { legacyLanguageServer: LanguageServerName } => Boolean(provider.legacyLanguageServer));
}

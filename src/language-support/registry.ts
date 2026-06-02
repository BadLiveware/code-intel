import type { LanguageCapability, LanguageId, LanguageSpec } from "./types.ts";

function features(overrides: Partial<LanguageCapability["features"]>): LanguageCapability["features"] {
	return {
		overview: true,
		outline: true,
		readSymbol: true,
		mutateSymbol: true,
		syntaxSearch: true,
		impact: "none",
		localMap: true,
		testMap: true,
		exactReferences: [],
		diagnostics: [],
		...overrides,
	};
}

export const LANGUAGE_CAPABILITIES: LanguageCapability[] = [
	{
		id: "go",
		label: "Go",
		aliases: ["golang"],
		extensions: [".go"],
		parser: { kind: "tree-sitter-wasm", wasm: "tree-sitter-go.wasm" },
		extractor: "go",
		category: "source",
		supportLevel: "strong",
		features: features({ impact: "code", exactReferences: ["gopls"], diagnostics: ["gopls"] }),
	},
	{
		id: "typescript",
		label: "TypeScript",
		aliases: ["ts"],
		extensions: [".ts", ".mts", ".cts"],
		parser: { kind: "tree-sitter-wasm", wasm: "tree-sitter-typescript.wasm" },
		extractor: "typescript",
		category: "source",
		supportLevel: "strong",
		features: features({ impact: "code", exactReferences: ["typescript"], diagnostics: ["typescript"] }),
	},
	{
		id: "tsx",
		label: "TSX",
		aliases: [],
		extensions: [".tsx"],
		parser: { kind: "tree-sitter-wasm", wasm: "tree-sitter-tsx.wasm" },
		extractor: "typescript",
		category: "source",
		supportLevel: "strong",
		features: features({ impact: "code", exactReferences: ["typescript"], diagnostics: ["typescript"] }),
	},
	{
		id: "javascript",
		label: "JavaScript",
		aliases: ["js", "jsx"],
		extensions: [".js", ".mjs", ".cjs", ".jsx"],
		parser: { kind: "tree-sitter-wasm", wasm: "tree-sitter-javascript.wasm" },
		extractor: "typescript",
		category: "source",
		supportLevel: "strong",
		features: features({ impact: "code", exactReferences: ["typescript"], diagnostics: ["typescript"] }),
	},
	{
		id: "rust",
		label: "Rust",
		aliases: ["rs"],
		extensions: [".rs"],
		parser: { kind: "tree-sitter-wasm", wasm: "tree-sitter-rust.wasm" },
		extractor: "rust",
		category: "source",
		supportLevel: "good",
		features: features({ impact: "code", exactReferences: ["rust-analyzer"], diagnostics: ["rust-analyzer"] }),
		limitations: ["Rust Analyzer references and diagnostics are optional provider features; current default routing is syntax evidence."],
	},
	{
		id: "python",
		label: "Python",
		aliases: ["py"],
		extensions: [".py"],
		parser: { kind: "tree-sitter-wasm", wasm: "tree-sitter-python.wasm" },
		extractor: "python",
		category: "source",
		supportLevel: "partial",
		features: features({ impact: "code", exactReferences: ["pyrefly"], diagnostics: ["pyrefly", "ty", "basedpyright", "pyright"] }),
		limitations: ["Python routing is current-source syntax evidence by default; Pyrefly references and diagnostics are optional provider features."],
	},
	{
		id: "cpp",
		label: "C/C++",
		aliases: ["c", "c++"],
		extensions: [".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".hxx"],
		parser: { kind: "tree-sitter-wasm", wasm: "tree-sitter-cpp.wasm" },
		extractor: "cpp",
		category: "source",
		supportLevel: "good",
		features: features({ impact: "code", exactReferences: ["clangd"], diagnostics: ["clangd"] }),
	},
	{
		id: "csharp",
		label: "C#",
		aliases: ["c#", "cs"],
		extensions: [".cs"],
		parser: { kind: "tree-sitter-wasm", wasm: "tree-sitter-c-sharp.wasm" },
		extractor: "csharp",
		category: "source",
		supportLevel: "parser",
		features: features({ impact: "code", exactReferences: ["csharp-ls"], diagnostics: ["csharp-ls"] }),
		limitations: ["C# routing is current-source syntax evidence by default; csharp-ls references can be promoted into impact-map related rows when confirmReferences is requested, and diagnostics are optional provider features."],
	},
	{
		id: "bash",
		label: "Bash",
		aliases: ["sh"],
		extensions: [".sh", ".bash"],
		parser: { kind: "tree-sitter-wasm", wasm: "tree-sitter-bash.wasm" },
		extractor: "shell",
		category: "source",
		supportLevel: "parser",
		features: features({ impact: "code", diagnostics: ["shellcheck"] }),
		limitations: ["Shell routing matches command names syntactically and cannot distinguish external commands from local functions without source inspection."],
	},
	{
		id: "zsh",
		label: "zsh",
		aliases: ["zshell"],
		extensions: [".zsh"],
		parser: { kind: "tree-sitter-wasm", wasm: "tree-sitter-bash.wasm" },
		extractor: "shell",
		category: "source",
		supportLevel: "parser",
		features: features({ impact: "code", diagnostics: ["zsh"] }),
		limitations: ["zsh currently uses the Bash Tree-sitter grammar, so zsh-specific syntax can parse imperfectly."],
	},
	{
		id: "markdown",
		label: "Markdown",
		aliases: ["md"],
		extensions: [".md", ".markdown", ".mdx", ".mdc"],
		parser: { kind: "scanner" },
		extractor: "markdown",
		category: "doc",
		supportLevel: "doc",
		features: features({ impact: "doc", syntaxSearch: false, diagnostics: ["markdownlint"] }),
		limitations: ["Markdown support is document-structure routing, not code semantics or exact code impact."],
	},
	{
		id: "java",
		label: "Java",
		aliases: [],
		extensions: [".java"],
		parser: { kind: "tree-sitter-wasm", wasm: "tree-sitter-java.wasm" },
		extractor: "generic",
		category: "source",
		supportLevel: "parser",
		features: features({ mutateSymbol: false }),
	},
	{
		id: "ruby",
		label: "Ruby",
		aliases: ["rb"],
		extensions: [".rb"],
		parser: { kind: "tree-sitter-wasm", wasm: "tree-sitter-ruby.wasm" },
		extractor: "generic",
		category: "source",
		supportLevel: "parser",
		features: features({ mutateSymbol: false }),
	},
	{
		id: "php",
		label: "PHP",
		aliases: [],
		extensions: [".php"],
		parser: { kind: "tree-sitter-wasm", wasm: "tree-sitter-php.wasm" },
		extractor: "generic",
		category: "source",
		supportLevel: "parser",
		features: features({ mutateSymbol: false }),
	},
	{
		id: "css",
		label: "CSS",
		aliases: [],
		extensions: [".css"],
		parser: { kind: "tree-sitter-wasm", wasm: "tree-sitter-css.wasm" },
		extractor: "generic",
		category: "source",
		supportLevel: "parser",
		features: features({ readSymbol: false, mutateSymbol: false }),
	},
];

const aliasToId = new Map<string, LanguageId>();
for (const capability of LANGUAGE_CAPABILITIES) {
	aliasToId.set(capability.id, capability.id);
	for (const alias of capability.aliases) aliasToId.set(alias.toLowerCase(), capability.id);
}

export const LANGUAGE_SPECS: LanguageSpec[] = LANGUAGE_CAPABILITIES
	.filter((capability) => capability.parser.kind === "tree-sitter-wasm")
	.map((capability) => ({ id: capability.id, wasm: capability.parser.kind === "tree-sitter-wasm" ? capability.parser.wasm : "", extensions: capability.extensions }));

export const IMPACT_LANGUAGE_IDS = LANGUAGE_CAPABILITIES.filter((capability) => capability.features.impact === "code").map((capability) => capability.id);

export function normalizeLanguageId(language: string): LanguageId | undefined {
	return aliasToId.get(language.trim().toLowerCase());
}

export function languageCapability(language: string): LanguageCapability | undefined {
	const id = normalizeLanguageId(language);
	return id ? LANGUAGE_CAPABILITIES.find((capability) => capability.id === id) : undefined;
}

export function languageSpec(language: string): LanguageSpec | undefined {
	const id = normalizeLanguageId(language);
	return id ? LANGUAGE_SPECS.find((spec) => spec.id === id) : undefined;
}

export function languageIdsForExtension(extension: string): LanguageId[] {
	return LANGUAGE_CAPABILITIES.filter((capability) => capability.extensions.includes(extension)).map((capability) => capability.id);
}

export function languageCapabilitySummary(): Record<string, unknown> {
	return Object.fromEntries(LANGUAGE_CAPABILITIES.map((capability) => [capability.id, {
		label: capability.label,
		aliases: capability.aliases,
		extensions: capability.extensions,
		parser: capability.parser.kind === "tree-sitter-wasm" ? capability.parser.wasm : capability.parser.kind,
		extractor: capability.extractor,
		category: capability.category,
		supportLevel: capability.supportLevel,
		features: capability.features,
		limitations: capability.limitations ?? [],
	}]));
}

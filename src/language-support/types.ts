import type { ResultDetail } from "../core/types.ts";
import type { ParsedFile, SymbolRecord } from "../tree-sitter/nodes.ts";

export type LanguageId =
	| "csharp"
	| "go"
	| "rust"
	| "typescript"
	| "tsx"
	| "javascript"
	| "bash"
	| "zsh"
	| "python"
	| "markdown"
	| "cpp"
	| "java"
	| "ruby"
	| "php"
	| "css";

export type ParserSource =
	| { kind: "tree-sitter-wasm"; wasm: string }
	| { kind: "scanner" };

export type ImpactMode = "code" | "doc" | "none";
export type LanguageSupportLevel = "strong" | "good" | "partial" | "parser" | "doc";
export type DiagnosticProviderId = "typescript" | "gopls" | "rust-analyzer" | "pyrefly" | "ty" | "basedpyright" | "pyright" | "clangd" | "csharp-ls" | "shellcheck" | "zsh" | "markdownlint";
export type ReferenceProviderId = "typescript" | "gopls" | "rust-analyzer" | "pyrefly" | "ty" | "pyright" | "jedi" | "clangd" | "csharp-ls" | "marksman";

export interface LanguageFeatureSupport {
	overview: boolean;
	outline: boolean;
	readSymbol: boolean;
	mutateSymbol: boolean;
	syntaxSearch: boolean;
	impact: ImpactMode;
	localMap: boolean;
	testMap: boolean;
	exactReferences: ReferenceProviderId[];
	diagnostics: DiagnosticProviderId[];
}

export interface LanguageCapability {
	id: LanguageId;
	label: string;
	aliases: string[];
	extensions: string[];
	parser: ParserSource;
	extractor: string;
	category: "source" | "doc" | "config" | "other";
	supportLevel: LanguageSupportLevel;
	features: LanguageFeatureSupport;
	limitations?: string[];
}

export interface LanguageSpec {
	id: string;
	wasm: string;
	extensions: string[];
}

export interface LanguageExtractor {
	(parsed: ParsedFile, detail: ResultDetail): { definitions: SymbolRecord[]; candidates: SymbolRecord[] };
}

export interface ImportScanner {
	(language: string | undefined, source: string): string[];
}

export interface SyntaxAdapter {
	id: string;
	languages: LanguageId[];
}

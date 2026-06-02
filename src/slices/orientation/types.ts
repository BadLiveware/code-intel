import type { ResultDetail } from "../../core/types.ts";

export interface CodeIntelRepoOverviewParams {
	repoRoot?: string;
	paths?: string[];
	tier?: "shape" | "files";
	maxDepth?: number;
	maxDirs?: number;
	maxFilesPerDir?: number;
	maxSymbolsPerFile?: number;
	includeGlobs?: string[];
	excludeGlobs?: string[];
	includeGenerated?: boolean;
	includeVendor?: boolean;
	timeoutMs?: number;
}

export interface CodeIntelFileOutlineParams {
	repoRoot?: string;
	path: string;
	includeImports?: boolean;
	includeNonExported?: boolean;
	maxSymbols?: number;
	timeoutMs?: number;
	detail?: ResultDetail;
}

export interface CodeIntelTestMapParams {
	repoRoot?: string;
	path?: string;
	symbols?: string[];
	names?: string[];
	testPaths?: string[];
	maxResults?: number;
	maxLiteralMatches?: number;
	confirmReferences?: "gopls" | "typescript" | "clangd" | "rust-analyzer" | "csharp-ls" | "pyrefly";
	maxReferenceRoots?: number;
	maxReferenceResults?: number;
	timeoutMs?: number;
	detail?: ResultDetail;
}

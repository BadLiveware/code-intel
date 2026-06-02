import type { ResultDetail } from "../../core/types.ts";

export interface CodeIntelImpactMapParams {
	repoRoot?: string;
	symbols?: string[];
	changedFiles?: string[];
	baseRef?: string;
	paths?: string[];
	includeGlobs?: string[];
	excludeGlobs?: string[];
	includeIgnored?: boolean;
	maxResults?: number;
	maxRootSymbols?: number;
	timeoutMs?: number;
	detail?: ResultDetail;
	confirmReferences?: "gopls" | "typescript" | "clangd" | "rust-analyzer" | "csharp-ls" | "pyrefly";
	maxReferenceRoots?: number;
	maxReferenceResults?: number;
	includeReferenceDeclarations?: boolean;
}

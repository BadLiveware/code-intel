import type { ResultDetail } from "../../core/types.ts";

export interface CodeIntelSyntaxSearchParams {
	repoRoot?: string;
	pattern: string;
	language?: string;
	paths?: string[];
	includeGlobs?: string[];
	excludeGlobs?: string[];
	selector?: string;
	maxResults?: number;
	timeoutMs?: number;
	strictness?: "cst" | "smart" | "ast" | "relaxed" | "signature" | "template";
	detail?: ResultDetail;
}

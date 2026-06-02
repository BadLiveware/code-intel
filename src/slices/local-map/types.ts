import type { ResultDetail } from "../../core/types.ts";

export interface CodeIntelLocalMapParams {
	repoRoot?: string;
	anchors?: string[];
	names?: string[];
	paths?: string[];
	language?: string;
	includeSyntax?: boolean;
	maxResults?: number;
	maxPerName?: number;
	timeoutMs?: number;
	detail?: ResultDetail;
}

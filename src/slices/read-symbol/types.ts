import type { SourceDetail } from "../../core/types.ts";

export interface CodeIntelReadSymbolParams {
	repoRoot?: string;
	target?: Record<string, unknown>;
	path?: string;
	symbol?: string;
	name?: string;
	owner?: string;
	kind?: string;
	signature?: string;
	symbolRef?: string;
	rangeId?: string;
	line?: number;
	column?: number;
	contextLines?: number;
	include?: string[];
	maxContextSegments?: number;
	maxBytes?: number;
	timeoutMs?: number;
	detail?: SourceDetail;
}

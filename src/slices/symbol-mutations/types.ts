export interface CodeIntelReplaceSymbolParams {
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
	oldText?: string;
	oldHash?: string;
	newText: string;
	normalizeEol?: boolean;
	timeoutMs?: number;
}

export interface CodeIntelInsertRelativeParams {
	repoRoot?: string;
	anchor?: Record<string, unknown>;
	target?: Record<string, unknown>;
	path?: string;
	symbol?: string;
	name?: string;
	owner?: string;
	kind?: string;
	signature?: string;
	symbolRef?: string;
	rangeId?: string;
	position: "before" | "after";
	text: string;
	anchorHash?: string;
	normalizeEol?: boolean;
	timeoutMs?: number;
}

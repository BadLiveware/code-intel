export interface CodeIntelPostEditDiagnostic {
	path: string;
	line: number;
	column?: number;
	endLine?: number;
	endColumn?: number;
	severity?: "error" | "warning" | "info" | "hint" | string;
	source?: string;
	code?: string;
	message?: string;
	provenance?: "supplied" | "collected" | string;
	freshness?: string;
}

export interface CodeIntelPostEditMapParams {
	repoRoot?: string;
	changedFiles?: string[];
	baseRef?: string;
	includeChangedSymbols?: boolean;
	includeCallers?: boolean;
	includeTests?: boolean;
	includeDiagnostics?: boolean;
	diagnostics?: Array<CodeIntelPostEditDiagnostic | Record<string, unknown>>;
	avoidReReadingCompleteReturnedSegments?: boolean;
	maxResults?: number;
	timeoutMs?: number;
}

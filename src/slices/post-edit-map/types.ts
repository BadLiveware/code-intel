export interface CodeIntelChangedFileContext {
	file: string;
	kind: "source" | "source-no-symbols" | "source-unparsed" | "project-boundary" | "unsupported";
	language?: string;
	symbolCount?: number;
	reason: string;
	validationHint: string;
}

export interface CodeIntelPostEditValidationHint {
	kind: string;
	file?: string;
	message: string;
}

export interface CodeIntelPostEditDiagnostic {
	path: string;
	line: number;
	column?: number;
	endLine?: number;
	endColumn?: number;
	severity?: "error" | "warning" | "info" | "hint" | string;
	source?: string;
	provider?: string;
	code?: string;
	message?: string;
	provenance?: "supplied" | "collected" | string;
	freshness?: string;
	baselineStatus?: "not-compared" | string;
}

export type CodeIntelPostEditPhaseName = "discoverChangedFiles" | "changedSymbols" | "impactMap" | "testMap" | "diagnosticsCollection" | "diagnosticTargets";
export type CodeIntelPostEditPhaseStatus = "passed" | "failed" | "skipped" | "aborted";

export interface CodeIntelPostEditPhaseTiming {
	name: CodeIntelPostEditPhaseName;
	status: CodeIntelPostEditPhaseStatus;
	elapsedMs: number;
	itemCount?: number;
	diagnostic?: string;
	slow?: boolean;
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

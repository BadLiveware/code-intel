import { asRecord, header, rows } from "../../core/compact.ts";

export function compactPostEdit(payload: Record<string, unknown>): string {
	const summary = asRecord(payload.summary);
	const changedSymbolCount = Number(summary.changedSymbolCount ?? rows(payload.changedSymbols).length ?? 0);
	const relatedCount = Number(summary.relatedCount ?? rows(payload.related).length ?? 0);
	const testCandidateCount = Number(summary.testCandidateCount ?? rows(payload.testCandidates).length ?? 0);
	const diagnosticCount = Number(summary.diagnosticCount ?? summary.diagnosticTargetCount ?? rows(payload.touchedDiagnostics).length ?? 0);
	const projectBoundaryCount = Number(summary.projectBoundaryCount ?? rows(payload.projectBoundaryFiles).length ?? 0);
	const nonSymbolChangedFileCount = Number(summary.nonSymbolChangedFileCount ?? rows(payload.nonSymbolChangedFiles).length ?? 0);
	const nextActions = rows(payload.validationHints)
		.map((row) => typeof row.message === "string" ? row.message.trim() : "")
		.filter(Boolean)
		.slice(0, 4);
	if (nextActions.length === 0) {
		if (diagnosticCount > 0) nextActions.push(`inspect ${diagnosticCount} touched diagnostic(s)`);
		if (relatedCount > 0) nextActions.push(`read ${relatedCount} related caller/consumer row(s)`);
		if (testCandidateCount > 0) nextActions.push(`inspect or run ${testCandidateCount} likely test candidate(s)`);
		if (projectBoundaryCount > 0) nextActions.push(`validate ${projectBoundaryCount} project/build boundary file(s)`);
		if (changedSymbolCount === 0 && Array.isArray(payload.changedFiles) && payload.changedFiles.length > 0) nextActions.push("inspect changed files directly; no changed declarations were extracted");
	}
	if (nextActions.length === 0) nextActions.push("read changed declaration targets and run project-native validation as needed");
	const summaryParts = [
		`changed=${changedSymbolCount}`,
		`related=${relatedCount}`,
		`tests=${testCandidateCount}`,
		`diagnostics=${diagnosticCount}`,
		projectBoundaryCount > 0 ? `projectBoundary=${projectBoundaryCount}` : undefined,
		nonSymbolChangedFileCount > 0 ? `noSymbolFiles=${nonSymbolChangedFileCount}` : undefined,
	].filter(Boolean);
	const lines = [
		`${header("post_edit_map", payload)} files=${Array.isArray(payload.changedFiles) ? payload.changedFiles.length : 0}`,
		`next: ${nextActions.join("; ")}`,
		`summary: ${summaryParts.join(" ")}`,
	];
	const phaseIssues = rows(payload.phaseTimings)
		.filter((row) => row.status === "failed" || row.status === "aborted" || row.slow === true)
		.slice(0, 6);
	if (phaseIssues.length > 0) {
		lines.push(`phases: ${phaseIssues.map((row) => {
			const elapsed = typeof row.elapsedMs === "number" ? ` ${row.elapsedMs}ms` : "";
			const diagnostic = typeof row.diagnostic === "string" && row.diagnostic.trim() ? ` — ${row.diagnostic.trim()}` : "";
			const status = row.status === "failed" || row.status === "aborted" ? String(row.status) : "slow";
			return `${String(row.name ?? "phase")} ${status}${elapsed}${diagnostic}`;
		}).join("; ")}`);
	}
	const limitations = Array.isArray(payload.limitations) ? payload.limitations.map(String).filter(Boolean).slice(0, 3) : [];
	if (limitations.length > 0) lines.push(`limitations: ${limitations.join("; ")}`);
	for (const row of rows(payload.changedFileContexts).filter((row) => row.kind !== "source").slice(0, 8)) {
		const file = String(row.file ?? "");
		const kind = String(row.kind ?? "changed-file");
		const reason = typeof row.reason === "string" && row.reason.trim() ? ` — ${row.reason.trim()}` : "";
		lines.push(`changed-file ${file} ${kind}${reason}`.trim());
	}
	for (const row of rows(payload.changedSymbols).slice(0, 12)) {
		const target = asRecord(row.target);
		const range = asRecord(target.range);
		lines.push(`changed ${String(target.path ?? "")}:${String(range.startLine ?? "?")}-${String(range.endLine ?? "?")} ${String(target.name ?? "?")}`.trim());
	}
	for (const row of rows(payload.related).slice(0, 8)) {
		const line = row.line ? `:${String(row.line)}` : "";
		lines.push(`related ${String(row.file ?? "")}${line} ${String(row.kind ?? "?")} ${String(row.name ?? row.symbol ?? "?")}`.trim());
	}
	for (const row of rows(payload.testCandidates).slice(0, 6)) {
		const score = row.score === undefined ? "" : ` score=${String(row.score)}`;
		lines.push(`test ${String(row.file ?? "")}${score}`.trim());
	}
	const targetDiagnostics = rows(payload.diagnosticTargets).slice(0, 8);
	for (const row of targetDiagnostics) {
		const target = asRecord(row.target);
		const diagnostic = asRecord(row.diagnostic);
		const code = diagnostic.code ? ` ${String(diagnostic.code)}` : "";
		lines.push(`diagnostic ${String(target.path ?? diagnostic.path ?? "")}:${String(diagnostic.line ?? "?")} ${String(diagnostic.severity ?? "?")}${code} ${String(target.name ?? "?")}`.trim());
	}
	if (targetDiagnostics.length === 0) {
		for (const diagnostic of rows(payload.touchedDiagnostics).slice(0, 8)) {
			const code = diagnostic.code ? ` ${String(diagnostic.code)}` : "";
			lines.push(`diagnostic ${String(diagnostic.path ?? "")}:${String(diagnostic.line ?? "?")} ${String(diagnostic.severity ?? "?")}${code}`.trim());
		}
	}
	return lines.join("\n");
}

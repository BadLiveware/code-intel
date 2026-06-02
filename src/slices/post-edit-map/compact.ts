import { asRecord, header, rows } from "../../core/compact.ts";

export function compactPostEdit(payload: Record<string, unknown>): string {
	const summary = asRecord(payload.summary);
	const lines = [
		`${header("post_edit_map", payload)} files=${Array.isArray(payload.changedFiles) ? payload.changedFiles.length : 0}`,
		`summary: changed=${summary.changedSymbolCount ?? 0} related=${summary.relatedCount ?? 0} tests=${summary.testCandidateCount ?? 0} diagnostics=${summary.diagnosticCount ?? summary.diagnosticTargetCount ?? 0}`,
	];
	for (const row of rows(payload.changedSymbols).slice(0, 12)) {
		const target = asRecord(row.target);
		const range = asRecord(target.range);
		lines.push(`changed ${String(target.path ?? "")}:${String(range.startLine ?? "?")}-${String(range.endLine ?? "?")} ${String(target.name ?? "?")}`.trim());
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

import { header, isRecord, rows } from "../../core/compact.ts";

export function compactLocal(payload: Record<string, unknown>): string {
	const summary = isRecord(payload.summary) ? payload.summary : {};
	const coverage = isRecord(payload.coverage) ? payload.coverage : {};
	const lines = [`${header("local_map", payload)}`, `summary: files=${rows(summary.suggestedFiles).length} truncated=${coverage.truncated === true}`];
	for (const file of rows(summary.suggestedFiles).slice(0, 40)) lines.push(`${String(file.file ?? "?")} count=${file.count ?? "?"} reasons=${Array.isArray(file.reasons) ? file.reasons.slice(0, 3).join(";") : ""}`);
	return lines.join("\n");
}

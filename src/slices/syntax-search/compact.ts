import { header, isRecord, loc, rows } from "../../core/compact.ts";

export function compactSyntax(payload: Record<string, unknown>): string {
	const summary = isRecord(payload.summary) ? payload.summary : {};
	const lines = [`${header("syntax_search", payload)}`, `summary: matches=${summary.matchCount ?? rows(payload.matches).length} files=${summary.fileCount ?? "?"}`];
	for (const match of rows(payload.matches).slice(0, 50)) lines.push(`${String(match.file ?? "")}${loc(match)} ${String(match.kind ?? "match")} ${String(match.name ?? match.text ?? "")}`.trim());
	return lines.join("\n");
}

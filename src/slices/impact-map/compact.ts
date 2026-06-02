import { compactKind, header, isRecord, loc, rows, str } from "../../core/compact.ts";

export function compactImpact(payload: Record<string, unknown>): string {
	const summary = isRecord(payload.summary) ? payload.summary : {};
	const coverage = isRecord(payload.coverage) ? payload.coverage : {};
	const lines = [
		`${header("impact_map", payload)} roots=${Array.isArray(payload.rootSymbols) ? payload.rootSymbols.join(",") : ""}`,
		`summary: rootFiles=${summary.rootFileCount ?? "?"} relatedFiles=${summary.relatedFileCount ?? "?"} related=${rows(payload.related).length} parsed=${coverage.filesParsed ?? "?"} truncated=${coverage.truncated === true}`,
	];
	if (str(payload.reason)) lines.push(`reason: ${str(payload.reason)}`);
	for (const root of rows(payload.roots).slice(0, 20)) lines.push(`root ${String(root.file ?? "")}${loc(root)} ${compactKind(root.kind)} ${String(root.name ?? "?")}`.trim());
	for (const row of rows(payload.related).slice(0, 40)) lines.push(`rel ${String(row.file ?? "")}${loc(row)} ${String(row.kind ?? "?")} ${String(row.name ?? "?")} root=${String(row.rootSymbol ?? "?")}`.trim());
	const refs = isRecord(payload.referenceConfirmation) ? payload.referenceConfirmation : undefined;
	if (refs) lines.push(`refs ${refs.backend ?? "?"}: ok=${refs.ok !== false} count=${rows(refs.references).length}`);
	return lines.join("\n");
}

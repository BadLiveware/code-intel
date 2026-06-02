import { header, isRecord, rows } from "../../core/compact.ts";

export function compactRoute(payload: Record<string, unknown>): string {
	const summary = isRecord(payload.summary) ? payload.summary : {};
	const coverage = isRecord(payload.coverage) ? payload.coverage : {};
	const lines = [
		`${header("repo_route", payload)} terms=${Array.isArray(payload.terms) ? payload.terms.join(",") : "?"}`,
		`summary: candidates=${summary.candidateCount ?? "?"} returned=${summary.returnedCount ?? "?"} scanned=${summary.filesScanned ?? "?"} truncated=${coverage.truncated === true}`,
	];
	let index = 1;
	for (const candidate of rows(payload.candidates).slice(0, 30)) {
		lines.push(`${index++}. ${String(candidate.file ?? "?")} score=${candidate.score ?? "?"}`);
		const evidence = rows(candidate.evidence);
		const pathTerms = evidence.filter((row) => row.kind === "path" || row.kind === "basename").map((row) => `${row.kind}:${row.term}`).join(",");
		const literals = evidence.filter((row) => row.kind === "literal").map((row) => `${row.term}@${row.line}`).join(", ");
		if (pathTerms) lines.push(`   path: ${pathTerms}`);
		if (literals) lines.push(`   literal: ${literals}`);
	}
	return lines.join("\n");
}

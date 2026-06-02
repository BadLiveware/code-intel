import { header, isRecord, rows } from "../../core/compact.ts";

export function compactTestMap(payload: Record<string, unknown>): string {
	const summary = isRecord(payload.summary) ? payload.summary : {};
	const coverage = isRecord(payload.coverage) ? payload.coverage : {};
	const target = isRecord(payload.target) ? payload.target : {};
	const lines = [
		`${header("test_map", payload)} target=${String(target.path ?? "?")}`,
		`summary: candidates=${summary.candidateCount ?? "?"} returned=${summary.returnedCount ?? "?"} scanned=${coverage.searchedFileCount ?? "?"} truncated=${coverage.truncated === true}`,
	];
	let index = 1;
	for (const candidate of rows(payload.candidates).slice(0, 30)) {
		lines.push(`${index++}. ${String(candidate.file ?? "?")} score=${candidate.score ?? "?"}`);
		const evidence = rows(candidate.evidence);
		const pathTerms = evidence.filter((row) => row.kind === "path_term" || row.kind === "path_basename").map((row) => row.term).join(",");
		const literals = evidence.filter((row) => row.kind === "literal_match").map((row) => `${row.term}@${row.line}`).join(", ");
		if (pathTerms) lines.push(`   path: ${pathTerms}`);
		if (literals) lines.push(`   literal: ${literals}`);
	}
	return lines.join("\n");
}

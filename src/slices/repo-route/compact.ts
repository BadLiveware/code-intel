import { header, isRecord, rows } from "../../core/compact.ts";

export function compactRoute(payload: Record<string, unknown>): string {
	const summary = isRecord(payload.summary) ? payload.summary : {};
	const coverage = isRecord(payload.coverage) ? payload.coverage : {};
	const offset = typeof summary.offset === "number" ? summary.offset : 0;
	const nextOffset = typeof summary.nextOffset === "number" ? summary.nextOffset : undefined;
	const remainingCount = typeof summary.remainingCount === "number" ? summary.remainingCount : 0;
	const lines = [
		`${header("repo_route", payload)} terms=${Array.isArray(payload.terms) ? payload.terms.join(",") : "?"}`,
		`summary: candidates=${summary.candidateCount ?? "?"} returned=${summary.returnedCount ?? "?"} offset=${offset} scanned=${summary.filesScanned ?? "?"} truncated=${coverage.truncated === true}`,
	];
	if (nextOffset !== undefined) lines.push(`more: ${remainingCount} remaining; rerun with offset=${nextOffset}`);
	const guidance = Array.isArray(payload.guidance) ? payload.guidance.map(String).filter(Boolean).slice(0, 4) : [];
	if (guidance.length > 0) lines.push(`narrow: ${guidance.join("; ")}`);
	let index = offset + 1;
	for (const candidate of rows(payload.candidates).slice(0, 30)) {
		lines.push(`${index++}. ${String(candidate.file ?? "?")} score=${candidate.score ?? "?"}${candidate.category ? ` ${String(candidate.category)}` : ""}`);
		const evidence = rows(candidate.evidence).slice(0, 8);
		const strongest = evidence.slice(0, 4).map((row) => {
			const line = row.line === undefined ? "" : `@${String(row.line)}`;
			const generic = row.generic === true ? ":generic" : "";
			return `${String(row.kind ?? "evidence")}:${String(row.term ?? "?")}${line}${generic}`;
		}).join(", ");
		if (strongest) lines.push(`   evidence: ${strongest}`);
	}
	return lines.join("\n");
}

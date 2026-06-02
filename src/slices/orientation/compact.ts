import { compactKind, declarationLine, header, isRecord, rows } from "../../core/compact.ts";

function langText(dir: Record<string, unknown>): string {
	const langs = rows(dir.dominantLanguages).slice(0, 4).map((lang) => `${lang.language}:${lang.files}`).join(",");
	return langs ? ` lang=${langs}` : "";
}

function appendDir(lines: string[], dir: Record<string, unknown>, indent: number): void {
	const pad = "  ".repeat(indent);
	lines.push(`${pad}${String(dir.path ?? ".")} dirs=${dir.dirs ?? 0} files=${dir.files ?? 0} src=${dir.sourceFiles ?? 0} test=${dir.testFiles ?? 0}${langText(dir)}${dir.truncated ? " trunc" : ""}`);
	for (const file of rows(dir.fileEntries).slice(0, 20)) {
		lines.push(`${pad}  ${String(file.path ?? "?")} ${file.language ?? ""} ${file.category ?? ""}${file.truncated ? " trunc" : ""}`.trimEnd());
		for (const decl of rows(file.declarations).slice(0, 8)) lines.push(`${pad}${declarationLine(decl)}`);
	}
	for (const child of rows(dir.children).slice(0, 20)) appendDir(lines, child, indent + 1);
}

export function compactOverview(payload: Record<string, unknown>): string {
	const summary = isRecord(payload.summary) ? payload.summary : {};
	const coverage = isRecord(payload.coverage) ? payload.coverage : {};
	const lines = [
		`${header("repo_overview", payload)} tier=${String(payload.tier ?? "?")} roots=${rows(payload.roots).length || (Array.isArray(payload.roots) ? payload.roots.join(",") : "?")}`,
		`summary: dirs=${summary.dirCount ?? "?"} files=${summary.fileCount ?? "?"} source=${summary.sourceFileCount ?? "?"} tests=${summary.testFileCount ?? "?"} parsed=${summary.parsedFileCount ?? 0} truncated=${coverage.truncated === true}`,
	];
	const excluded = isRecord(coverage.excludedDirs) ? Object.entries(coverage.excludedDirs).map(([k, v]) => `${k}=${v}`).join(" ") : "";
	if (excluded) lines.push(`excluded: ${excluded}`);
	for (const dir of rows(payload.directories).slice(0, 20)) appendDir(lines, dir, 0);
	return lines.join("\n");
}

export function compactOutline(payload: Record<string, unknown>): string {
	const summary = isRecord(payload.summary) ? payload.summary : {};
	const coverage = isRecord(payload.coverage) ? payload.coverage : {};
	const lines = [
		`${header("file_outline", payload)} ${String(payload.language ?? "?")} ${String(payload.file ?? "?")}`,
		`summary: decls=${summary.declarationCount ?? "?"} imports=${summary.importCount ?? 0} truncated=${coverage.truncated === true}`,
	];
	const imports = Array.isArray(payload.imports) ? payload.imports.map(String) : [];
	if (imports.length) lines.push(`imports: ${imports.slice(0, 8).join(", ")}${imports.length > 8 ? ` … ${imports.length - 8} more` : ""}`);
	lines.push("declarations:");
	for (const decl of rows(payload.declarations).slice(0, 80)) lines.push(declarationLine(decl));
	return lines.join("\n");
}

export { compactKind };

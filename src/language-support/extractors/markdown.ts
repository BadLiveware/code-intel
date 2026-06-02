import type { ResultDetail } from "../../core/types.ts";
import type { ParsedFile, SymbolRecord } from "../../tree-sitter/nodes.ts";

interface HeadingRecord {
	line: number;
	level: number;
	text: string;
	slug: string;
}

function slugify(text: string): string {
	return text.trim().toLowerCase().replace(/[`*_~]/g, "").replace(/[^a-z0-9\s-]/g, "").trim().replace(/\s+/g, "-");
}

function lineLength(lines: string[], line: number): number {
	return (lines[line - 1] ?? "").length + 1;
}

function definition(parsed: ParsedFile, lines: string[], kind: string, name: string, line: number, endLine: number, detail: ResultDetail, type?: string): SymbolRecord {
	return {
		kind,
		name,
		symbol: name,
		file: parsed.file,
		language: parsed.language,
		evidence: `markdown:${kind}`,
		type,
		line,
		column: 1,
		endLine,
		endColumn: lineLength(lines, endLine),
		exported: true,
		...(detail === "snippets" ? { text: lines[line - 1]?.trimEnd() ?? "", snippet: lines[line - 1]?.trimEnd() ?? "" } : {}),
	};
}

function candidate(parsed: ParsedFile, lines: string[], kind: string, name: string, line: number, detail: ResultDetail, type?: string): SymbolRecord {
	return {
		kind,
		name,
		symbol: name,
		file: parsed.file,
		language: parsed.language,
		evidence: `markdown:${kind}`,
		type,
		line,
		column: 1,
		endLine: line,
		endColumn: lineLength(lines, line),
		...(detail === "snippets" ? { text: lines[line - 1]?.trimEnd() ?? "", snippet: lines[line - 1]?.trimEnd() ?? "" } : {}),
	};
}

function frontmatterEnd(lines: string[]): number | undefined {
	const delimiter = lines[0] === "---" || lines[0] === "+++" ? lines[0] : undefined;
	if (!delimiter) return undefined;
	for (let index = 1; index < lines.length; index++) if (lines[index] === delimiter) return index + 1;
	return undefined;
}

function collectHeadings(lines: string[]): HeadingRecord[] {
	const headings: HeadingRecord[] = [];
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		const atx = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
		if (atx) {
			headings.push({ line: index + 1, level: atx[1].length, text: atx[2].trim(), slug: slugify(atx[2]) });
			continue;
		}
		const next = lines[index + 1];
		if (line.trim() && next && /^(=+|-+)\s*$/.test(next)) {
			headings.push({ line: index + 1, level: next.trim().startsWith("=") ? 1 : 2, text: line.trim(), slug: slugify(line) });
			index++;
		}
	}
	return headings;
}

function sectionEnd(heading: HeadingRecord, headings: HeadingRecord[], lines: string[]): number {
	const next = headings.find((candidate) => candidate.line > heading.line && candidate.level <= heading.level);
	return next ? next.line - 1 : lines.length;
}

function collectCodeFences(parsed: ParsedFile, lines: string[], definitions: SymbolRecord[], detail: ResultDetail): void {
	for (let index = 0; index < lines.length; index++) {
		const match = /^(```+|~~~+)\s*([^\s`]*)/.exec(lines[index]);
		if (!match) continue;
		const fence = match[1];
		const language = match[2] || "code";
		let end = lines.length;
		for (let close = index + 1; close < lines.length; close++) {
			if (lines[close].startsWith(fence)) {
				end = close + 1;
				break;
			}
		}
		definitions.push(definition(parsed, lines, "code_fence", language, index + 1, end, detail, language));
		index = end - 1;
	}
}

function collectLinks(parsed: ParsedFile, lines: string[], candidates: SymbolRecord[], detail: ResultDetail): void {
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		for (const match of line.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) candidates.push(candidate(parsed, lines, "syntax_selector", match[1], index + 1, detail, "link"));
		const ref = /^\s*\[[^\]]+\]:\s+(\S+)/.exec(line);
		if (ref) candidates.push(candidate(parsed, lines, "syntax_keyed_field", ref[1], index + 1, detail, "reference"));
	}
}

export function extractMarkdownFileRecords(parsed: ParsedFile, detail: ResultDetail): { definitions: SymbolRecord[]; candidates: SymbolRecord[] } {
	const lines = parsed.source.split(/\r?\n/);
	const definitions: SymbolRecord[] = [];
	const candidates: SymbolRecord[] = [];
	const fmEnd = frontmatterEnd(lines);
	if (fmEnd) definitions.push(definition(parsed, lines, "frontmatter", "frontmatter", 1, fmEnd, detail));
	const headings = collectHeadings(lines);
	for (const heading of headings) definitions.push(definition(parsed, lines, "markdown_section", heading.text, heading.line, sectionEnd(heading, headings, lines), detail, `h${heading.level}#${heading.slug}`));
	collectCodeFences(parsed, lines, definitions, detail);
	collectLinks(parsed, lines, candidates, detail);
	return { definitions, candidates };
}

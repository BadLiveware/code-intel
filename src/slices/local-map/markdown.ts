import * as fs from "node:fs";
import * as path from "node:path";
import type { ResultDetail } from "../../types.ts";
import { ensureInsideRoot } from "../../repo.ts";
import { extractFileRecords, readSourceFileAsParsed, type SymbolRecord } from "../../tree-sitter.ts";
import { summarizeFileDistribution } from "../../util.ts";

const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown", ".mdx", ".mdc"]);
const EXCLUDED_DIRS = new Set([".git", ".hg", ".svn", "node_modules", "vendor", "dist", "build", "target", ".cache"]);
const MAX_MARKDOWN_FILES = 500;

export interface MarkdownLocalMapParams {
	names: string[];
	paths: string[];
	repoRoot: string;
	timeoutMs: number;
	maxPerName: number;
	detail: ResultDetail;
	signal?: AbortSignal;
}

function repoRelative(repoRoot: string, absoluteFile: string): string {
	return path.relative(repoRoot, absoluteFile).split(path.sep).join(path.posix.sep);
}

function slugify(text: string): string {
	return text.trim().toLowerCase().replace(/[`*_~]/g, "").replace(/[^a-z0-9\s-]/g, "").trim().replace(/\s+/g, "-");
}

function addMarkdownFile(repoRoot: string, absoluteFile: string, files: Set<string>): void {
	if (MARKDOWN_EXTENSIONS.has(path.extname(absoluteFile))) files.add(repoRelative(repoRoot, absoluteFile));
}

function collectMarkdownFiles(repoRoot: string, paths: string[], timeoutMs: number, signal: AbortSignal | undefined, diagnostics: string[]): { files: string[]; truncated: boolean } {
	const started = Date.now();
	const files = new Set<string>();
	const roots = paths.length > 0 ? paths : ["."];
	const stack: string[] = [];
	let truncated = false;
	for (const inputPath of roots) {
		try {
			const safe = ensureInsideRoot(repoRoot, inputPath);
			const absolute = path.resolve(repoRoot, safe);
			if (!fs.existsSync(absolute)) continue;
			const stat = fs.statSync(absolute);
			if (stat.isDirectory()) stack.push(absolute);
			else if (stat.isFile()) addMarkdownFile(repoRoot, absolute, files);
		} catch (error) {
			diagnostics.push(`${inputPath}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	while (stack.length > 0) {
		if (signal?.aborted || Date.now() - started > timeoutMs || files.size >= MAX_MARKDOWN_FILES) {
			truncated = true;
			break;
		}
		const current = stack.pop() as string;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(current, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const absolute = path.join(current, entry.name);
			if (entry.isDirectory()) {
				if (!EXCLUDED_DIRS.has(entry.name)) stack.push(absolute);
			} else if (entry.isFile()) addMarkdownFile(repoRoot, absolute, files);
			if (files.size >= MAX_MARKDOWN_FILES) {
				truncated = true;
				break;
			}
		}
	}
	return { files: [...files].sort(), truncated };
}

function recordSearchText(record: SymbolRecord): string {
	return [record.name, record.symbol, record.type, record.evidence, record.text, record.snippet].filter((value): value is string => typeof value === "string").join("\n").toLowerCase();
}

function recordMatches(record: SymbolRecord, name: string): boolean {
	const normalized = name.toLowerCase();
	const slug = slugify(name);
	const haystack = recordSearchText(record);
	return haystack.includes(normalized) || (slug.length > 0 && haystack.includes(slug));
}

function normalizeRecord(record: SymbolRecord, name: string, detail: ResultDetail): Record<string, unknown> {
	const output: Record<string, unknown> = {
		kind: record.kind,
		name: record.name,
		rootSymbol: name,
		file: record.file,
		line: record.line,
		column: record.column,
		endLine: record.endLine,
		endColumn: record.endColumn,
		language: record.language,
		type: record.type,
		evidence: record.evidence,
		reason: record.kind === "markdown_section" ? `Markdown heading/slug matched ${name}` : `Markdown link/fence/frontmatter matched ${name}`,
	};
	if (detail === "snippets") {
		output.text = record.text;
		output.snippet = record.snippet;
	}
	return Object.fromEntries(Object.entries(output).filter(([, value]) => value !== undefined));
}

export function runMarkdownLocalMaps(params: MarkdownLocalMapParams): Record<string, unknown>[] {
	const diagnostics: string[] = [];
	const collected = collectMarkdownFiles(params.repoRoot, params.paths, params.timeoutMs, params.signal, diagnostics);
	const records: SymbolRecord[] = [];
	for (const file of collected.files) {
		try {
			const parsed = readSourceFileAsParsed(params.repoRoot, file, "markdown");
			const extracted = extractFileRecords(parsed, params.detail);
			records.push(...extracted.definitions, ...extracted.candidates);
		} catch (error) {
			diagnostics.push(`${file}: Markdown scanner failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return params.names.map((name) => {
		const matches = records.filter((record) => recordMatches(record, name));
		const returned = matches.slice(0, params.maxPerName).map((record) => normalizeRecord(record, name, params.detail));
		return {
			kind: "markdown_doc",
			name,
			ok: diagnostics.length === 0 || matches.length > 0,
			backend: "markdown-scanner",
			repoRoot: params.repoRoot,
			detail: params.detail,
			language: "markdown",
			paths: params.paths.length > 0 ? params.paths : ["."],
			matchCount: matches.length,
			returned: returned.length,
			truncated: collected.truncated || matches.length > returned.length,
			summary: summarizeFileDistribution(returned),
			matches: returned,
			coverage: { filesScanned: collected.files.length, maxFiles: MAX_MARKDOWN_FILES },
			diagnostics,
			limitations: ["Markdown local maps use headings, generated slugs, links, frontmatter, and code fence metadata as document routing evidence."],
		};
	});
}

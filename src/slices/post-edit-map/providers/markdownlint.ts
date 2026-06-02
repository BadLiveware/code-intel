import * as path from "node:path";
import { commandDiagnostic, findExecutable, parseJson, runCommand } from "../../../exec.ts";
import { semanticProviderMetadata } from "../../../lsp/provider-metadata.ts";
import { ensureInsideRoot } from "../../../repo.ts";
import type { CodeIntelConfig } from "../../../types.ts";
import { isRecord } from "../../../util.ts";
import type { NormalizedPostEditDiagnostic } from "../diagnostics.ts";

const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown", ".mdx", ".mdc"]);
const metadata = semanticProviderMetadata("markdownlint-cli2");

export interface MarkdownlintDiagnosticCollectionResult {
	diagnostics: NormalizedPostEditDiagnostic[];
	providerStatus: Record<string, unknown>;
	toolDiagnostics: string[];
	limitations: string[];
}

function markdownFiles(files: string[]): string[] {
	return [...new Set(files.filter((file) => MARKDOWN_EXTENSIONS.has(path.extname(file))).slice(0, 50))];
}

function providerStatus(available: string, fileCount: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return { provider: "markdownlint-cli2", basis: metadata.evidence.diagnostics ?? "markdownlint-cli2:json", available, fileCount, freshness: "current-workspace-files", baselineStatus: "not-compared", ...extra };
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function diagnosticFromRule(repoRoot: string, rawFile: string, rule: Record<string, unknown>): NormalizedPostEditDiagnostic | undefined {
	const line = numberValue(rule.lineNumber) ?? numberValue(rule.line);
	if (!line) return undefined;
	let file: string;
	try {
		file = ensureInsideRoot(repoRoot, path.isAbsolute(rawFile) ? rawFile : path.resolve(repoRoot, rawFile));
	} catch {
		return undefined;
	}
	const ruleNames = Array.isArray(rule.ruleNames) ? rule.ruleNames : [];
	const errorRange = Array.isArray(rule.errorRange) ? rule.errorRange : [];
	const column = numberValue(rule.errorColumn) ?? numberValue(rule.column) ?? numberValue(errorRange[0]);
	const rangeLength = numberValue(errorRange[1]);
	return {
		path: file,
		line,
		column,
		endColumn: column && rangeLength ? column + rangeLength : undefined,
		severity: "warning",
		source: "markdownlint-cli2",
		code: stringValue(ruleNames[0]) ?? stringValue(rule.ruleName) ?? stringValue(rule.ruleDescription),
		message: stringValue(rule.ruleDescription) ?? stringValue(rule.errorDetail) ?? stringValue(rule.message),
		provenance: "collected",
		freshness: "current-workspace-files",
		baselineStatus: "not-compared",
	};
}

function diagnosticsFromArray(repoRoot: string, rows: unknown[], rawFile?: string): NormalizedPostEditDiagnostic[] {
	return rows.flatMap((row) => {
		if (!isRecord(row)) return [];
		const file = stringValue(row.fileName) ?? stringValue(row.file) ?? rawFile;
		if (!file) return [];
		const nested = Array.isArray(row.errors) ? row.errors : Array.isArray(row.issues) ? row.issues : undefined;
		if (nested) return diagnosticsFromArray(repoRoot, nested, file);
		const diagnostic = diagnosticFromRule(repoRoot, file, row);
		return diagnostic ? [diagnostic] : [];
	});
}

function parseMarkdownlintJson(repoRoot: string, text: string): NormalizedPostEditDiagnostic[] {
	const payload = parseJson<unknown>(text);
	if (Array.isArray(payload)) return diagnosticsFromArray(repoRoot, payload);
	if (!isRecord(payload)) return [];
	if (Array.isArray(payload.errors)) return diagnosticsFromArray(repoRoot, payload.errors);
	const rows: NormalizedPostEditDiagnostic[] = [];
	for (const [file, value] of Object.entries(payload)) {
		if (Array.isArray(value)) rows.push(...diagnosticsFromArray(repoRoot, value, file));
		else if (isRecord(value)) rows.push(...diagnosticsFromArray(repoRoot, [value], file));
	}
	return rows;
}

export async function collectMarkdownlintDiagnostics(repoRoot: string, changedFiles: string[], config: CodeIntelConfig, signal?: AbortSignal): Promise<MarkdownlintDiagnosticCollectionResult> {
	const safeFiles = markdownFiles(changedFiles);
	const limitations = [
		"markdownlint-cli2 diagnostics are collected for touched Markdown files only; link checking remains explicit and non-default.",
		"Diagnostics are not baseline-compared yet, so collected rows are current diagnostics in touched files rather than proven-new diagnostics.",
	];
	if (safeFiles.length === 0) return { diagnostics: [], providerStatus: providerStatus("not-applicable", 0), toolDiagnostics: [], limitations };
	if (signal?.aborted) return { diagnostics: [], providerStatus: providerStatus("error", safeFiles.length, { diagnostic: "aborted" }), toolDiagnostics: ["markdownlint-cli2 diagnostic collection aborted"], limitations };
	const executable = findExecutable("markdownlint-cli2");
	if (!executable) return { diagnostics: [], providerStatus: providerStatus("missing", safeFiles.length, { diagnostic: metadata.missingDiagnostic }), toolDiagnostics: [], limitations };
	const result = await runCommand(executable, ["--json", ...safeFiles], { cwd: repoRoot, timeoutMs: Math.min(config.queryTimeoutMs, 30_000), maxOutputBytes: Math.min(config.maxOutputBytes, 500_000), signal });
	const diagnostics = parseMarkdownlintJson(repoRoot, result.stdout || result.stderr);
	const commandIssue = commandDiagnostic(result);
	const statusDiagnostic = diagnostics.length === 0 ? commandIssue : undefined;
	return {
		diagnostics,
		providerStatus: providerStatus(statusDiagnostic ? "error" : "available", safeFiles.length, { executable, diagnostic: statusDiagnostic, diagnosticCount: diagnostics.length }),
		toolDiagnostics: statusDiagnostic ? [`markdownlint-cli2: ${statusDiagnostic}`] : [],
		limitations,
	};
}

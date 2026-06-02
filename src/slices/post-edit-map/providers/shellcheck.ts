import * as path from "node:path";
import { commandDiagnostic, findExecutable, parseJson, runCommand } from "../../../exec.ts";
import { semanticProviderMetadata } from "../../../lsp/provider-metadata.ts";
import { ensureInsideRoot } from "../../../repo.ts";
import type { CodeIntelConfig } from "../../../types.ts";
import { isRecord } from "../../../util.ts";
import type { NormalizedPostEditDiagnostic } from "../diagnostics.ts";

const SHELL_EXTENSIONS = new Set([".sh", ".bash"]);
const metadata = semanticProviderMetadata("shellcheck");

export interface ShellCheckDiagnosticCollectionResult {
	diagnostics: NormalizedPostEditDiagnostic[];
	providerStatus: Record<string, unknown>;
	toolDiagnostics: string[];
	limitations: string[];
}

function shellFiles(files: string[]): string[] {
	return [...new Set(files.filter((file) => SHELL_EXTENSIONS.has(path.extname(file))).slice(0, 50))];
}

function providerStatus(available: string, fileCount: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return { provider: "shellcheck", basis: metadata.evidence.diagnostics ?? "shellcheck:json", available, fileCount, freshness: "current-workspace-files", baselineStatus: "not-compared", ...extra };
}

function severity(level: unknown): string {
	if (level === "error" || level === "warning" || level === "info") return level;
	if (level === "style") return "hint";
	return typeof level === "string" && level.trim() ? level : "warning";
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeComment(repoRoot: string, row: unknown): NormalizedPostEditDiagnostic | undefined {
	if (!isRecord(row)) return undefined;
	const rawFile = typeof row.file === "string" ? row.file : undefined;
	const line = numberValue(row.line);
	if (!rawFile || !line) return undefined;
	let file: string;
	try {
		file = ensureInsideRoot(repoRoot, path.isAbsolute(rawFile) ? rawFile : path.resolve(repoRoot, rawFile));
	} catch {
		return undefined;
	}
	const code = numberValue(row.code);
	return {
		path: file,
		line,
		column: numberValue(row.column),
		endLine: numberValue(row.endLine),
		endColumn: numberValue(row.endColumn),
		severity: severity(row.level),
		source: "shellcheck",
		code: code ? `SC${code}` : undefined,
		message: typeof row.message === "string" ? row.message : undefined,
		provenance: "collected",
		freshness: "current-workspace-files",
		baselineStatus: "not-compared",
	};
}

function parseShellCheckJson(repoRoot: string, text: string): NormalizedPostEditDiagnostic[] {
	const payload = parseJson<unknown>(text);
	if (!isRecord(payload)) return [];
	const comments = Array.isArray(payload.comments) ? payload.comments : [];
	return comments.map((row) => normalizeComment(repoRoot, row)).filter((row): row is NormalizedPostEditDiagnostic => Boolean(row));
}

export async function collectShellCheckDiagnostics(repoRoot: string, changedFiles: string[], config: CodeIntelConfig, signal?: AbortSignal): Promise<ShellCheckDiagnosticCollectionResult> {
	const safeFiles = shellFiles(changedFiles);
	const limitations = [
		"ShellCheck diagnostics are collected for touched sh/bash files only; zsh files use a separate syntax-only provider.",
		"Diagnostics are not baseline-compared yet, so collected rows are current diagnostics in touched files rather than proven-new diagnostics.",
	];
	if (safeFiles.length === 0) return { diagnostics: [], providerStatus: providerStatus("not-applicable", 0), toolDiagnostics: [], limitations };
	if (signal?.aborted) return { diagnostics: [], providerStatus: providerStatus("error", safeFiles.length, { diagnostic: "aborted" }), toolDiagnostics: ["ShellCheck diagnostic collection aborted"], limitations };
	const executable = findExecutable("shellcheck");
	if (!executable) return { diagnostics: [], providerStatus: providerStatus("missing", safeFiles.length, { diagnostic: metadata.missingDiagnostic }), toolDiagnostics: [], limitations };
	const result = await runCommand(executable, ["-f", "json", ...safeFiles], { cwd: repoRoot, timeoutMs: Math.min(config.queryTimeoutMs, 30_000), maxOutputBytes: Math.min(config.maxOutputBytes, 500_000), signal });
	const diagnostics = parseShellCheckJson(repoRoot, result.stdout || result.stderr);
	const commandIssue = commandDiagnostic(result);
	const statusDiagnostic = diagnostics.length === 0 ? commandIssue : undefined;
	return {
		diagnostics,
		providerStatus: providerStatus(statusDiagnostic ? "error" : "available", safeFiles.length, { executable, diagnostic: statusDiagnostic, diagnosticCount: diagnostics.length }),
		toolDiagnostics: statusDiagnostic ? [`shellcheck: ${statusDiagnostic}`] : [],
		limitations,
	};
}

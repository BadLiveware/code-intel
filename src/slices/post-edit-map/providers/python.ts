import * as path from "node:path";
import { commandDiagnostic, findExecutable, parseJson, runCommand } from "../../../exec.ts";
import { semanticProviderMetadata } from "../../../lsp/provider-metadata.ts";
import { ensureInsideRoot } from "../../../repo.ts";
import type { CodeIntelConfig } from "../../../types.ts";
import { isRecord } from "../../../util.ts";
import type { NormalizedPostEditDiagnostic } from "../diagnostics.ts";

const PYTHON_EXTENSIONS = new Set([".py"]);
const PYTHON_PROVIDER_NAMES = ["pyrefly", "ty", "basedpyright", "pyright"] as const;
const pythonProviderMetadata = PYTHON_PROVIDER_NAMES.map((name) => semanticProviderMetadata(name));

type PythonProviderName = (typeof PYTHON_PROVIDER_NAMES)[number];
type PythonProviderMetadata = (typeof pythonProviderMetadata)[number];

export interface PythonDiagnosticCollectionResult {
	diagnostics: NormalizedPostEditDiagnostic[];
	providerStatuses: Record<string, unknown>[];
	toolDiagnostics: string[];
	limitations: string[];
}

function pythonFiles(files: string[]): string[] {
	return [...new Set(files.filter((file) => PYTHON_EXTENSIONS.has(path.extname(file))).slice(0, 50))];
}

function providerStatus(metadata: PythonProviderMetadata, available: string, fileCount: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return { provider: metadata.name, basis: metadata.evidence.diagnostics ?? `${metadata.name}:diagnostics`, available, fileCount, freshness: "current-workspace-files", baselineStatus: "not-compared", ...extra };
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function ensureDiagnosticFile(repoRoot: string, rawFile: string | undefined, targetFiles: Set<string>): string | undefined {
	if (!rawFile) return undefined;
	try {
		const file = ensureInsideRoot(repoRoot, path.isAbsolute(rawFile) ? rawFile : path.resolve(repoRoot, rawFile));
		return targetFiles.has(file) ? file : undefined;
	} catch {
		return undefined;
	}
}

function severity(value: unknown): string {
	const text = stringValue(value)?.toLowerCase();
	if (text === "error" || text === "warning" || text === "hint") return text;
	if (text === "information" || text === "informational" || text === "notice") return "info";
	if (text === "blocker" || text === "critical" || text === "major") return "error";
	if (text === "minor") return "warning";
	return text ?? "info";
}

function normalizePyrightDiagnostic(repoRoot: string, row: unknown, targetFiles: Set<string>, source: PythonProviderName): NormalizedPostEditDiagnostic | undefined {
	if (!isRecord(row)) return undefined;
	const range = isRecord(row.range) ? row.range : undefined;
	const start = isRecord(range?.start) ? range.start : undefined;
	const startLine = numberValue(start?.line);
	const startCharacter = numberValue(start?.character);
	const file = ensureDiagnosticFile(repoRoot, stringValue(row.file), targetFiles);
	if (!file || startLine === undefined || startCharacter === undefined) return undefined;
	const end = isRecord(range?.end) ? range.end : undefined;
	const endLine = numberValue(end?.line);
	const endCharacter = numberValue(end?.character);
	return {
		path: file,
		line: startLine + 1,
		column: startCharacter + 1,
		endLine: endLine === undefined ? undefined : endLine + 1,
		endColumn: endCharacter === undefined ? undefined : endCharacter + 1,
		severity: severity(row.severity),
		source,
		provider: source,
		code: stringValue(row.rule) ?? stringValue(row.code),
		message: stringValue(row.message),
		provenance: "collected",
		freshness: "current-workspace-files",
		baselineStatus: "not-compared",
	};
}

function normalizePyreflyDiagnostic(repoRoot: string, row: unknown, targetFiles: Set<string>): NormalizedPostEditDiagnostic | undefined {
	if (!isRecord(row)) return undefined;
	const line = numberValue(row.line);
	const column = numberValue(row.column);
	const file = ensureDiagnosticFile(repoRoot, stringValue(row.path), targetFiles);
	if (!file || line === undefined) return undefined;
	return {
		path: file,
		line,
		column,
		endLine: numberValue(row.stop_line),
		endColumn: numberValue(row.stop_column),
		severity: "error",
		source: "pyrefly",
		provider: "pyrefly",
		code: stringValue(row.name) ?? (numberValue(row.code) === undefined ? undefined : String(numberValue(row.code))),
		message: stringValue(row.description),
		provenance: "collected",
		freshness: "current-workspace-files",
		baselineStatus: "not-compared",
	};
}

function normalizeTyDiagnostic(repoRoot: string, row: unknown, targetFiles: Set<string>): NormalizedPostEditDiagnostic | undefined {
	if (!isRecord(row)) return undefined;
	const location = isRecord(row.location) ? row.location : undefined;
	const positions = isRecord(location?.positions) ? location.positions : undefined;
	const begin = isRecord(positions?.begin) ? positions.begin : undefined;
	const end = isRecord(positions?.end) ? positions.end : undefined;
	const lines = isRecord(location?.lines) ? location.lines : undefined;
	const line = numberValue(begin?.line) ?? numberValue(lines?.begin);
	const file = ensureDiagnosticFile(repoRoot, stringValue(location?.path), targetFiles);
	if (!file || line === undefined) return undefined;
	return {
		path: file,
		line,
		column: numberValue(begin?.column),
		endLine: numberValue(end?.line),
		endColumn: numberValue(end?.column),
		severity: severity(row.severity),
		source: "ty",
		provider: "ty",
		code: stringValue(row.check_name),
		message: stringValue(row.description),
		provenance: "collected",
		freshness: "current-workspace-files",
		baselineStatus: "not-compared",
	};
}

function parseProviderJson(metadata: PythonProviderMetadata, repoRoot: string, text: string, targetFiles: Set<string>): NormalizedPostEditDiagnostic[] {
	const payload = parseJson<unknown>(text);
	if (!payload) return [];
	if (metadata.name === "pyrefly") {
		return (isRecord(payload) && Array.isArray(payload.errors) ? payload.errors : [])
			.map((row) => normalizePyreflyDiagnostic(repoRoot, row, targetFiles))
			.filter((row): row is NormalizedPostEditDiagnostic => Boolean(row));
	}
	if (metadata.name === "ty") {
		return (Array.isArray(payload) ? payload : [])
			.map((row) => normalizeTyDiagnostic(repoRoot, row, targetFiles))
			.filter((row): row is NormalizedPostEditDiagnostic => Boolean(row));
	}
	return (isRecord(payload) && Array.isArray(payload.generalDiagnostics) ? payload.generalDiagnostics : [])
		.map((row) => normalizePyrightDiagnostic(repoRoot, row, targetFiles, metadata.name as PythonProviderName))
		.filter((row): row is NormalizedPostEditDiagnostic => Boolean(row));
}

function providerArgs(provider: PythonProviderName, files: string[]): string[] {
	if (provider === "pyrefly") return ["check", "--output-format", "json", "--summary=none", ...files];
	if (provider === "ty") return ["check", "--output-format", "gitlab", "--no-progress", ...files];
	return ["--outputjson", ...files];
}

export async function collectPythonDiagnostics(repoRoot: string, changedFiles: string[], config: CodeIntelConfig, signal?: AbortSignal): Promise<PythonDiagnosticCollectionResult> {
	const safeFiles = pythonFiles(changedFiles);
	const limitations = [
		"Python diagnostics prefer Pyrefly, then ty, then basedpyright/pyright, and are collected for touched Python files only; this is not a project-wide validation run.",
		"Diagnostics are not baseline-compared yet, so collected rows are current diagnostics in touched files rather than proven-new diagnostics.",
	];
	if (safeFiles.length === 0) return { diagnostics: [], providerStatuses: pythonProviderMetadata.map((metadata) => providerStatus(metadata, "not-applicable", 0)), toolDiagnostics: [], limitations };
	if (signal?.aborted) return { diagnostics: [], providerStatuses: [providerStatus(pythonProviderMetadata[0], "error", safeFiles.length, { diagnostic: "aborted" })], toolDiagnostics: ["Python diagnostic collection aborted"], limitations };

	const missingStatuses: Record<string, unknown>[] = [];
	let selected: { metadata: PythonProviderMetadata; executable: string } | undefined;
	for (const metadata of pythonProviderMetadata) {
		const command = metadata.command;
		const executable = command ? findExecutable(command) : undefined;
		if (executable) {
			selected = { metadata, executable };
			break;
		}
		missingStatuses.push(providerStatus(metadata, "missing", safeFiles.length, { diagnostic: metadata.missingDiagnostic }));
	}
	if (!selected) return { diagnostics: [], providerStatuses: missingStatuses, toolDiagnostics: [], limitations };

	const result = await runCommand(selected.executable, providerArgs(selected.metadata.name as PythonProviderName, safeFiles), { cwd: repoRoot, timeoutMs: Math.min(config.queryTimeoutMs, 30_000), maxOutputBytes: Math.min(config.maxOutputBytes, 500_000), signal });
	const diagnostics = parseProviderJson(selected.metadata, repoRoot, result.stdout || result.stderr, new Set(safeFiles));
	const commandIssue = commandDiagnostic(result);
	const statusDiagnostic = diagnostics.length === 0 ? commandIssue : undefined;
	const provider = providerStatus(selected.metadata, statusDiagnostic ? "error" : "available", safeFiles.length, { executable: selected.executable, diagnostic: statusDiagnostic, diagnosticCount: diagnostics.length, fallbackFrom: missingStatuses.map((status) => status.provider) });
	return {
		diagnostics,
		providerStatuses: [...missingStatuses, provider],
		toolDiagnostics: statusDiagnostic ? [`${selected.metadata.name}: ${statusDiagnostic}`] : [],
		limitations,
	};
}

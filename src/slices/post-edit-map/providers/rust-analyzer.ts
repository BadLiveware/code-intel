import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { findExecutable } from "../../../exec.ts";
import { LspSession } from "../../../lsp/lsp-session.ts";
import { semanticProviderMetadata } from "../../../lsp/provider-metadata.ts";
import { rustAnalyzerWorkspaceRoot } from "../../../lsp/providers/rust-analyzer-lsp.ts";
import { uriToRepoFile } from "../../../lsp/uri.ts";
import { ensureInsideRoot } from "../../../repo.ts";
import type { CodeIntelConfig } from "../../../types.ts";
import { isRecord } from "../../../util.ts";
import type { NormalizedPostEditDiagnostic } from "../diagnostics.ts";

const RUST_EXTENSIONS = new Set([".rs"]);
const metadata = semanticProviderMetadata("rust-analyzer");

export interface RustAnalyzerDiagnosticCollectionResult {
	diagnostics: NormalizedPostEditDiagnostic[];
	providerStatus: Record<string, unknown>;
	toolDiagnostics: string[];
	limitations: string[];
}

function rustFiles(files: string[]): string[] {
	return [...new Set(files.filter((file) => RUST_EXTENSIONS.has(path.extname(file))).slice(0, 50))];
}

function providerStatus(available: string, fileCount: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return { provider: "rust-analyzer", basis: metadata.evidence.diagnostics ?? "rust-analyzer:publishDiagnostics", available, fileCount, freshness: "current-workspace-files", baselineStatus: "not-compared", ...extra };
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function severity(value: unknown): string {
	if (value === 1) return "error";
	if (value === 2) return "warning";
	if (value === 4) return "hint";
	return "info";
}

function diagnosticCode(value: unknown): string | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	if (typeof value === "string" && value.trim()) return value.trim();
	if (isRecord(value)) return stringValue(value.value) ?? (typeof value.value === "number" ? String(value.value) : undefined);
	return undefined;
}

function normalizeDiagnostic(repoRoot: string, uri: string | undefined, row: unknown): NormalizedPostEditDiagnostic | undefined {
	if (!uri || !isRecord(row)) return undefined;
	const range = isRecord(row.range) ? row.range : undefined;
	const start = isRecord(range?.start) ? range.start : undefined;
	const startLine = numberValue(start?.line);
	const startCharacter = numberValue(start?.character);
	if (!start || startLine === undefined || startCharacter === undefined) return undefined;
	let file: string;
	try {
		file = uriToRepoFile(repoRoot, uri);
	} catch {
		return undefined;
	}
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
		source: stringValue(row.source) ?? "rust-analyzer",
		code: diagnosticCode(row.code),
		message: stringValue(row.message),
		provenance: "collected",
		freshness: "current-workspace-files",
		baselineStatus: "not-compared",
	};
}

export async function collectRustAnalyzerDiagnostics(repoRoot: string, changedFiles: string[], config: CodeIntelConfig, signal?: AbortSignal): Promise<RustAnalyzerDiagnosticCollectionResult> {
	const safeFiles = rustFiles(changedFiles);
	const limitations = [
		"rust-analyzer diagnostics are collected from publishDiagnostics for touched Rust files only; this is not a project-wide cargo check run.",
		"Diagnostics are not baseline-compared yet, so collected rows are current diagnostics in touched files rather than proven-new diagnostics.",
	];
	if (safeFiles.length === 0) return { diagnostics: [], providerStatus: providerStatus("not-applicable", 0), toolDiagnostics: [], limitations };
	if (signal?.aborted) return { diagnostics: [], providerStatus: providerStatus("error", safeFiles.length, { diagnostic: "aborted" }), toolDiagnostics: ["rust-analyzer diagnostic collection aborted"], limitations };
	const executable = findExecutable("rust-analyzer");
	if (!executable) return { diagnostics: [], providerStatus: providerStatus("missing", safeFiles.length, { diagnostic: metadata.missingDiagnostic }), toolDiagnostics: [], limitations };

	const workspaceRoot = rustAnalyzerWorkspaceRoot(repoRoot, safeFiles);
	const timeoutMs = Math.min(config.queryTimeoutMs, 30_000);
	const diagnostics: NormalizedPostEditDiagnostic[] = [];
	const toolDiagnostics: string[] = [];
	let statusDiagnostic: string | undefined;
	const session = new LspSession({ command: executable, cwd: workspaceRoot, repoRoot, rootUri: pathToFileURL(workspaceRoot).href, timeoutMs, signal, name: "rust-analyzer" });
	try {
		const init = await session.initialize();
		if (init.error) {
			statusDiagnostic = init.error.message ?? "rust-analyzer initialize error";
			toolDiagnostics.push(`rust-analyzer initialize: ${statusDiagnostic}`);
		}
		for (const file of safeFiles) {
			if (signal?.aborted) break;
			let document;
			try {
				document = session.didOpen(ensureInsideRoot(repoRoot, file), "rust");
			} catch (error) {
				toolDiagnostics.push(error instanceof Error ? error.message : String(error));
				continue;
			}
			const published = await session.waitForDiagnostics(document.uri, Math.min(timeoutMs, 5_000));
			for (const row of Array.isArray(published?.diagnostics) ? published.diagnostics : []) {
				const diagnostic = normalizeDiagnostic(repoRoot, published?.uri, row);
				if (diagnostic) diagnostics.push(diagnostic);
			}
		}
	} catch (error) {
		statusDiagnostic = error instanceof Error ? error.message : String(error);
		toolDiagnostics.push(`rust-analyzer diagnostics failed: ${statusDiagnostic}`);
	} finally {
		await session.shutdown();
		toolDiagnostics.push(...session.diagnostics.map((diagnostic) => `rust-analyzer: ${diagnostic}`));
	}
	return {
		diagnostics,
		providerStatus: providerStatus(statusDiagnostic ? "error" : "available", safeFiles.length, { executable, workspaceRoot: ensureInsideRoot(repoRoot, workspaceRoot), diagnostic: statusDiagnostic, diagnosticCount: diagnostics.length }),
		toolDiagnostics,
		limitations,
	};
}

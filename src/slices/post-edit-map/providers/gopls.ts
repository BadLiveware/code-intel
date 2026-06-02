import * as path from "node:path";
import { commandDiagnostic, findExecutable, runCommand } from "../../../exec.ts";
import { ensureInsideRoot } from "../../../repo.ts";
import { semanticProviderMetadata } from "../../../lsp/provider-metadata.ts";
import type { CodeIntelConfig } from "../../../types.ts";
import type { NormalizedPostEditDiagnostic } from "../diagnostics.ts";

const GO_EXTENSIONS = new Set([".go"]);
const goplsMetadata = semanticProviderMetadata("gopls");

export interface GoplsDiagnosticCollectionResult {
	diagnostics: NormalizedPostEditDiagnostic[];
	providerStatus: Record<string, unknown>;
	toolDiagnostics: string[];
	limitations: string[];
}

function goFiles(files: string[]): string[] {
	return [...new Set(files.filter((file) => GO_EXTENSIONS.has(path.extname(file))).slice(0, 50))];
}

function providerStatus(available: string, fileCount: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		provider: "gopls",
		basis: goplsMetadata.evidence.diagnostics ?? "gopls:check",
		available,
		fileCount,
		freshness: "current-workspace-files",
		baselineStatus: "not-compared",
		...extra,
	};
}

function severityFromMessage(message: string): string {
	return /\b(warning|warn)\b/i.test(message) ? "warning" : "error";
}

function parseGoplsCheckLine(repoRoot: string, line: string): NormalizedPostEditDiagnostic | undefined {
	const match = /^(.*?):(\d+):(\d+)(?:-(\d+))?:\s*(.+)$/.exec(line.trim());
	if (!match) return undefined;
	let file: string;
	try {
		file = ensureInsideRoot(repoRoot, path.isAbsolute(match[1]) ? match[1] : path.resolve(repoRoot, match[1]));
	} catch {
		return undefined;
	}
	const message = match[5].trim();
	return {
		path: file,
		line: Number(match[2]),
		column: Number(match[3]),
		endColumn: match[4] ? Number(match[4]) : undefined,
		severity: severityFromMessage(message),
		source: "gopls",
		message,
		provenance: "collected",
		freshness: "current-workspace-files",
		baselineStatus: "not-compared",
	};
}

export async function collectGoplsDiagnostics(repoRoot: string, changedFiles: string[], config: CodeIntelConfig, signal?: AbortSignal): Promise<GoplsDiagnosticCollectionResult> {
	const safeFiles = goFiles(changedFiles);
	const limitations = [
		"gopls diagnostics are collected with `gopls check` for touched Go files only; this is not a project-wide `go test` or `go vet` run.",
		"Diagnostics are not baseline-compared yet, so collected rows are current diagnostics in touched files rather than proven-new diagnostics.",
	];
	if (safeFiles.length === 0) return { diagnostics: [], providerStatus: providerStatus("not-applicable", 0), toolDiagnostics: [], limitations };
	if (signal?.aborted) return { diagnostics: [], providerStatus: providerStatus("error", safeFiles.length, { diagnostic: "aborted" }), toolDiagnostics: ["gopls diagnostic collection aborted"], limitations };
	const executable = findExecutable("gopls");
	if (!executable) return { diagnostics: [], providerStatus: providerStatus("missing", safeFiles.length, { diagnostic: goplsMetadata.missingDiagnostic }), toolDiagnostics: [], limitations };

	const diagnostics: NormalizedPostEditDiagnostic[] = [];
	const toolDiagnostics: string[] = [];
	let statusDiagnostic: string | undefined;
	for (const file of safeFiles) {
		if (signal?.aborted) break;
		let safeFile: string;
		try {
			safeFile = ensureInsideRoot(repoRoot, file);
		} catch (error) {
			toolDiagnostics.push(error instanceof Error ? error.message : String(error));
			continue;
		}
		const result = await runCommand(executable, ["check", safeFile], { cwd: repoRoot, timeoutMs: Math.min(config.queryTimeoutMs, 30_000), maxOutputBytes: Math.min(config.maxOutputBytes, 500_000), signal });
		const commandIssue = commandDiagnostic(result);
		if (commandIssue && result.stdout.trim().length === 0 && result.stderr.trim().length === 0) {
			statusDiagnostic ??= commandIssue;
			toolDiagnostics.push(`gopls check ${safeFile}: ${commandIssue}`);
			continue;
		}
		for (const line of `${result.stdout}\n${result.stderr}`.split(/\r?\n/)) {
			const row = parseGoplsCheckLine(repoRoot, line);
			if (row) diagnostics.push(row);
		}
	}
	return {
		diagnostics,
		providerStatus: providerStatus(statusDiagnostic ? "error" : "available", safeFiles.length, { executable, diagnostic: statusDiagnostic, diagnosticCount: diagnostics.length }),
		toolDiagnostics,
		limitations,
	};
}

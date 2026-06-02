import * as path from "node:path";
import { commandDiagnostic, findExecutable, runCommand } from "../../../exec.ts";
import { semanticProviderMetadata } from "../../../lsp/provider-metadata.ts";
import { ensureInsideRoot } from "../../../repo.ts";
import type { CodeIntelConfig } from "../../../types.ts";
import type { NormalizedPostEditDiagnostic } from "../diagnostics.ts";

const ZSH_EXTENSIONS = new Set([".zsh"]);
const metadata = semanticProviderMetadata("zsh");

export interface ZshDiagnosticCollectionResult {
	diagnostics: NormalizedPostEditDiagnostic[];
	providerStatus: Record<string, unknown>;
	toolDiagnostics: string[];
	limitations: string[];
}

function zshFiles(files: string[]): string[] {
	return [...new Set(files.filter((file) => ZSH_EXTENSIONS.has(path.extname(file))).slice(0, 50))];
}

function providerStatus(available: string, fileCount: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return { provider: "zsh", basis: metadata.evidence.diagnostics ?? "zsh -n", available, fileCount, freshness: "current-workspace-files", baselineStatus: "not-compared", ...extra };
}

function parseZshLine(repoRoot: string, defaultFile: string, line: string): NormalizedPostEditDiagnostic | undefined {
	const match = /^(?:(.*?):)?(\d+):\s*(.+)$/.exec(line.trim());
	if (!match) return undefined;
	const rawFile = match[1]?.trim() || defaultFile;
	let file: string;
	try {
		file = ensureInsideRoot(repoRoot, path.isAbsolute(rawFile) ? rawFile : path.resolve(repoRoot, rawFile));
	} catch {
		return undefined;
	}
	return {
		path: file,
		line: Number(match[2]),
		severity: "error",
		source: "zsh -n",
		message: match[3].trim(),
		provenance: "collected",
		freshness: "current-workspace-files",
		baselineStatus: "not-compared",
	};
}

export async function collectZshDiagnostics(repoRoot: string, changedFiles: string[], config: CodeIntelConfig, signal?: AbortSignal): Promise<ZshDiagnosticCollectionResult> {
	const safeFiles = zshFiles(changedFiles);
	const limitations = [
		"zsh diagnostics use `zsh -n` syntax checks for touched .zsh files only; they do not prove runtime behavior.",
		"Diagnostics are not baseline-compared yet, so collected rows are current diagnostics in touched files rather than proven-new diagnostics.",
	];
	if (safeFiles.length === 0) return { diagnostics: [], providerStatus: providerStatus("not-applicable", 0), toolDiagnostics: [], limitations };
	if (signal?.aborted) return { diagnostics: [], providerStatus: providerStatus("error", safeFiles.length, { diagnostic: "aborted" }), toolDiagnostics: ["zsh diagnostic collection aborted"], limitations };
	const executable = findExecutable("zsh");
	if (!executable) return { diagnostics: [], providerStatus: providerStatus("missing", safeFiles.length, { diagnostic: metadata.missingDiagnostic }), toolDiagnostics: [], limitations };

	const diagnostics: NormalizedPostEditDiagnostic[] = [];
	const toolDiagnostics: string[] = [];
	let statusDiagnostic: string | undefined;
	for (const file of safeFiles) {
		let safeFile: string;
		try {
			safeFile = ensureInsideRoot(repoRoot, file);
		} catch (error) {
			toolDiagnostics.push(error instanceof Error ? error.message : String(error));
			continue;
		}
		const result = await runCommand(executable, ["-n", safeFile], { cwd: repoRoot, timeoutMs: Math.min(config.queryTimeoutMs, 30_000), maxOutputBytes: Math.min(config.maxOutputBytes, 500_000), signal });
		const parsed = result.stderr.split(/\r?\n/).map((row) => parseZshLine(repoRoot, safeFile, row)).filter((row): row is NormalizedPostEditDiagnostic => Boolean(row));
		diagnostics.push(...parsed);
		const commandIssue = commandDiagnostic(result);
		if (commandIssue && parsed.length === 0) {
			statusDiagnostic ??= commandIssue;
			toolDiagnostics.push(`zsh -n ${safeFile}: ${commandIssue}`);
		}
	}
	return {
		diagnostics,
		providerStatus: providerStatus(statusDiagnostic ? "error" : "available", safeFiles.length, { executable, diagnostic: statusDiagnostic, diagnosticCount: diagnostics.length }),
		toolDiagnostics,
		limitations,
	};
}

import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { commandDiagnostic, findExecutable, runCommand } from "../../exec.ts";
import { ensureInsideRoot } from "../../repo.ts";
import { LspSession, type LspLocation } from "../lsp-session.ts";
import { referenceProviderMetadata } from "../provider-metadata.ts";
import type { ReferenceConfirmationContext, ReferenceConfirmationLimits, ReferenceConfirmationOptions, ReferenceConfirmationProvider, ReferenceRoot } from "../types.ts";
import { uriToRepoFile } from "../uri.ts";

const csharpLsMetadata = referenceProviderMetadata("csharp-ls");
const csharpLsReferenceEvidence = csharpLsMetadata.evidence.references ?? "csharp-ls:textDocument/references";

function findWorkspaceRoot(repoRoot: string, file?: string): string | undefined {
	let directory = repoRoot;
	if (file) {
		try {
			directory = path.dirname(path.resolve(repoRoot, ensureInsideRoot(repoRoot, file)));
		} catch {
			directory = repoRoot;
		}
	}
	while (true) {
		const entries = fs.existsSync(directory) ? fs.readdirSync(directory) : [];
		if (entries.some((entry) => entry.endsWith(".sln") || entry.endsWith(".csproj"))) return directory;
		if (directory === repoRoot) return undefined;
		const parent = path.dirname(directory);
		if (parent === directory || !path.relative(repoRoot, parent).startsWith("..")) directory = parent;
		else return undefined;
	}
}

export function csharpLsWorkspaceRoot(repoRoot: string, files: string[] = []): string {
	for (const file of files) {
		const workspaceRoot = findWorkspaceRoot(repoRoot, file);
		if (workspaceRoot) return workspaceRoot;
	}
	return findWorkspaceRoot(repoRoot) ?? repoRoot;
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function symbolColumn(repoRoot: string, root: ReferenceRoot): number {
	try {
		const safeFile = ensureInsideRoot(repoRoot, root.file);
		const line = fs.readFileSync(path.resolve(repoRoot, safeFile), "utf-8").split(/\r?\n/)[root.line - 1];
		if (!line) return root.column;
		const index = line.indexOf(root.name);
		return index >= 0 ? index + 1 : root.column;
	} catch {
		return root.column;
	}
}

function uriToLocation(repoRoot: string, location: LspLocation, root: ReferenceRoot): Record<string, unknown> | undefined {
	const uri = typeof location?.uri === "string" ? location.uri : undefined;
	const range = location?.range;
	const startLine = numberValue(range?.start?.line);
	const startCharacter = numberValue(range?.start?.character);
	if (!uri || startLine === undefined || startCharacter === undefined) return undefined;
	let file: string;
	try {
		file = uriToRepoFile(repoRoot, uri);
	} catch {
		return undefined;
	}
	const endLine = numberValue(range?.end?.line);
	const endCharacter = numberValue(range?.end?.character);
	return {
		file,
		line: startLine + 1,
		column: startCharacter + 1,
		endLine: endLine === undefined ? undefined : endLine + 1,
		endColumn: endCharacter === undefined ? undefined : endCharacter + 1,
		rootSymbol: root.name,
		evidence: csharpLsReferenceEvidence,
	};
}

async function csharpLsVersion(executable: string, cwd: string, timeoutMs: number): Promise<string | undefined> {
	const result = await runCommand(executable, ["--version"], { cwd, timeoutMs: Math.min(timeoutMs, 5_000), maxOutputBytes: 20_000 });
	if (commandDiagnostic(result)) return undefined;
	return result.stdout.split(/\r?\n/).find(Boolean);
}

async function confirmCSharpLsRoots(roots: ReferenceRoot[], context: ReferenceConfirmationContext, options: ReferenceConfirmationOptions, limits: ReferenceConfirmationLimits) {
	const executable = findExecutable("csharp-ls");
	if (!executable) return { roots: [], references: [], diagnostics: [csharpLsMetadata.missingDiagnostic], limitations: csharpLsMetadata.limitations };
	const workspaceRoot = csharpLsWorkspaceRoot(context.repoRoot, roots.map((root) => root.file));
	const diagnostics: string[] = [];
	const confirmedRoots: Record<string, unknown>[] = [];
	const references: Record<string, unknown>[] = [];
	const session = new LspSession({ command: executable, cwd: workspaceRoot, repoRoot: context.repoRoot, rootUri: pathToFileURL(workspaceRoot).href, timeoutMs: limits.timeoutMs, signal: context.signal, name: "csharp-ls" });
	try {
		const init = await session.initialize();
		if (init.error) diagnostics.push(`initialize: ${init.error.message ?? "csharp-ls error"}`);
		for (const root of roots) {
			if (references.length >= limits.maxResults) break;
			let safeFile: string;
			try {
				safeFile = ensureInsideRoot(context.repoRoot, root.file);
			} catch (error) {
				diagnostics.push(`${root.name}: ${error instanceof Error ? error.message : String(error)}`);
				continue;
			}
			const column = symbolColumn(context.repoRoot, { ...root, file: safeFile });
			const document = session.didOpen(safeFile, "csharp");
			const response = await session.references(document, root.line - 1, Math.max(0, column - 1), options.includeDeclarations === true);
			confirmedRoots.push({ symbol: root.name, file: safeFile, line: root.line, column, kind: root.kind, position: `${safeFile}:${root.line}:${column}` });
			if (response.error) {
				diagnostics.push(`${root.name}: ${response.error.message ?? "csharp-ls references error"}`);
				continue;
			}
			const locations = Array.isArray(response.result) ? response.result : [];
			for (const location of locations) {
				if (references.length >= limits.maxResults) break;
				const parsed = uriToLocation(context.repoRoot, location as LspLocation, root);
				if (parsed) references.push(parsed);
			}
		}
	} catch (error) {
		diagnostics.push(error instanceof Error ? error.message : String(error));
	} finally {
		await session.shutdown();
		diagnostics.push(...session.diagnostics);
	}
	const stderr = session.stderr.split(/\r?\n/).find((line) => line.trim());
	if (stderr && diagnostics.length > 0) diagnostics.push(stderr.trim());
	const version = await csharpLsVersion(executable, workspaceRoot, limits.timeoutMs);
	return { executable, roots: confirmedRoots, references, diagnostics, limitations: csharpLsMetadata.limitations, version, workspaceRoot: ensureInsideRoot(context.repoRoot, workspaceRoot) };
}

export const csharpLsReferenceProvider: ReferenceConfirmationProvider = {
	name: "csharp-ls",
	evidence: csharpLsReferenceEvidence,
	supportedLanguages: csharpLsMetadata.supportedLanguages,
	missingDiagnostic: csharpLsMetadata.missingDiagnostic,
	noRootsDiagnostic: csharpLsMetadata.noRootsDiagnostic ?? "No C# roots with current-source definition locations were available for csharp-ls confirmation.",
	limitations: csharpLsMetadata.limitations,
	confirmRoots: confirmCSharpLsRoots,
};

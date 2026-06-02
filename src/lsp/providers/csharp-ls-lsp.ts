import * as fs from "node:fs";
import * as path from "node:path";
import { findExecutable } from "../../exec.ts";
import { ensureInsideRoot } from "../../repo.ts";
import type { LspLocation } from "../lsp-session.ts";
import { csharpLsWorkspaceRoot, withCSharpLsSession } from "./csharp-ls-session.ts";
import { referenceProviderMetadata } from "../provider-metadata.ts";
import type { ReferenceConfirmationContext, ReferenceConfirmationLimits, ReferenceConfirmationOptions, ReferenceConfirmationProvider, ReferenceRoot } from "../types.ts";
import { uriToRepoFile } from "../uri.ts";

const csharpLsMetadata = referenceProviderMetadata("csharp-ls");
const csharpLsReferenceEvidence = csharpLsMetadata.evidence.references ?? "csharp-ls:textDocument/references";

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

async function confirmCSharpLsRoots(roots: ReferenceRoot[], context: ReferenceConfirmationContext, options: ReferenceConfirmationOptions, limits: ReferenceConfirmationLimits) {
	const executable = findExecutable("csharp-ls");
	if (!executable) return { roots: [], references: [], diagnostics: [csharpLsMetadata.missingDiagnostic], limitations: csharpLsMetadata.limitations };
	const workspaceRoot = csharpLsWorkspaceRoot(context.repoRoot, roots.map((root) => root.file));
	const diagnostics: string[] = [];
	const confirmedRoots: Record<string, unknown>[] = [];
	const references: Record<string, unknown>[] = [];
	try {
		const run = await withCSharpLsSession({ repoRoot: context.repoRoot, workspaceRoot, executable, timeoutMs: limits.timeoutMs, persistent: options.persistentLsp === true, signal: context.signal }, async (lease) => {
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
				const document = lease.openDocument(safeFile, "csharp");
				const response = await lease.session.references(document, root.line - 1, Math.max(0, column - 1), options.includeDeclarations === true, limits.timeoutMs);
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
			return undefined;
		});
		diagnostics.push(...run.diagnostics);
		return {
			executable: run.executable,
			roots: confirmedRoots,
			references,
			diagnostics,
			limitations: csharpLsMetadata.limitations,
			version: run.version,
			workspaceRoot: ensureInsideRoot(context.repoRoot, run.workspaceRoot),
			session: { persistent: run.persistent, reused: run.reused, restarted: run.restarted },
		};
	} catch (error) {
		diagnostics.push(error instanceof Error ? error.message : String(error));
		return { executable, roots: confirmedRoots, references, diagnostics, limitations: csharpLsMetadata.limitations, workspaceRoot: ensureInsideRoot(context.repoRoot, workspaceRoot) };
	}
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

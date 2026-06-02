import * as fs from "node:fs";
import * as path from "node:path";
import { commandDiagnostic, findExecutable, runCommand } from "../../exec.ts";
import { ensureInsideRoot } from "../../repo.ts";
import { LspSession, type LspLocation } from "../lsp-session.ts";
import { referenceProviderMetadata } from "../provider-metadata.ts";
import type { ReferenceConfirmationContext, ReferenceConfirmationLimits, ReferenceConfirmationOptions, ReferenceConfirmationProvider, ReferenceRoot } from "../types.ts";
import { uriToRepoFile } from "../uri.ts";

const clangdMetadata = referenceProviderMetadata("clangd");
const clangdReferenceEvidence = clangdMetadata.evidence.references ?? "clangd:textDocument/references";

export function findCompileCommandsDir(repoRoot: string): string | undefined {
	const candidates = ["compile_commands.json", "build/compile_commands.json", "build_debug/compile_commands.json", "build_release/compile_commands.json", "cmake-build-debug/compile_commands.json"];
	for (const candidate of candidates) {
		const full = path.join(repoRoot, candidate);
		if (fs.existsSync(full)) return path.dirname(full);
	}
	return undefined;
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

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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
		evidence: clangdReferenceEvidence,
	};
}

async function clangdVersion(executable: string, cwd: string, timeoutMs: number): Promise<string | undefined> {
	const result = await runCommand(executable, ["--version"], { cwd, timeoutMs: Math.min(timeoutMs, 5_000), maxOutputBytes: 20_000 });
	if (commandDiagnostic(result)) return undefined;
	return result.stdout.split(/\r?\n/).find(Boolean);
}

async function confirmClangdRoots(roots: ReferenceRoot[], context: ReferenceConfirmationContext, options: ReferenceConfirmationOptions, limits: ReferenceConfirmationLimits) {
	const executable = findExecutable("clangd");
	if (!executable) return { roots: [], references: [], diagnostics: [clangdMetadata.missingDiagnostic], limitations: clangdMetadata.limitations };
	const compileCommandsDir = findCompileCommandsDir(context.repoRoot);
	if (!compileCommandsDir) return { executable, roots: [], references: [], diagnostics: ["compile_commands.json not found in repo root or common build directories"], limitations: clangdMetadata.limitations };

	const diagnostics: string[] = [];
	const confirmedRoots: Record<string, unknown>[] = [];
	const references: Record<string, unknown>[] = [];
	const session = new LspSession({ command: executable, args: [`--compile-commands-dir=${compileCommandsDir}`], cwd: context.repoRoot, repoRoot: context.repoRoot, timeoutMs: limits.timeoutMs, signal: context.signal, name: "clangd" });
	try {
		const init = await session.initialize();
		if (init.error) diagnostics.push(`initialize: ${init.error.message ?? "clangd error"}`);
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
			const document = session.didOpen(safeFile, "cpp");
			const response = await session.references(document, root.line - 1, Math.max(0, column - 1), options.includeDeclarations === true);
			confirmedRoots.push({ symbol: root.name, file: safeFile, line: root.line, column, kind: root.kind, position: `${safeFile}:${root.line}:${column}` });
			if (response.error) {
				diagnostics.push(`${root.name}: ${response.error.message ?? "clangd references error"}`);
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
	const version = await clangdVersion(executable, context.repoRoot, limits.timeoutMs);
	return { executable, roots: confirmedRoots, references, diagnostics, limitations: clangdMetadata.limitations, version, compileCommandsDir };
}

export const clangdReferenceProvider: ReferenceConfirmationProvider = {
	name: "clangd",
	evidence: clangdReferenceEvidence,
	supportedLanguages: clangdMetadata.supportedLanguages,
	missingDiagnostic: clangdMetadata.missingDiagnostic,
	noRootsDiagnostic: clangdMetadata.noRootsDiagnostic ?? "No C/C++ roots with current-source definition locations were available for clangd confirmation.",
	limitations: clangdMetadata.limitations,
	confirmRoots: confirmClangdRoots,
};

import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { commandDiagnostic, findExecutable, runCommand } from "../../exec.ts";
import { ensureInsideRoot } from "../../repo.ts";
import { LspSession, type LspLocation } from "../lsp-session.ts";
import { referenceProviderMetadata } from "../provider-metadata.ts";
import type { ReferenceConfirmationContext, ReferenceConfirmationLimits, ReferenceConfirmationOptions, ReferenceConfirmationProvider, ReferenceRoot } from "../types.ts";
import { uriToRepoFile } from "../uri.ts";

const pyreflyMetadata = referenceProviderMetadata("pyrefly");
const pyreflyReferenceEvidence = pyreflyMetadata.evidence.references ?? "pyrefly:textDocument/references";

function findPythonWorkspaceRoot(repoRoot: string, file?: string): string | undefined {
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
		if (entries.some((entry) => entry === "pyrefly.toml" || entry === "pyproject.toml" || entry === "setup.py" || entry === "setup.cfg")) return directory;
		if (directory === repoRoot) return undefined;
		const parent = path.dirname(directory);
		if (parent === directory || !path.relative(repoRoot, parent).startsWith("..")) directory = parent;
		else return undefined;
	}
}

export function pyreflyWorkspaceRoot(repoRoot: string, files: string[] = []): string {
	for (const file of files) {
		const workspaceRoot = findPythonWorkspaceRoot(repoRoot, file);
		if (workspaceRoot) return workspaceRoot;
	}
	return findPythonWorkspaceRoot(repoRoot) ?? repoRoot;
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function symbolPosition(repoRoot: string, root: ReferenceRoot): { line: number; column: number } {
	try {
		const safeFile = ensureInsideRoot(repoRoot, root.file);
		const lines = fs.readFileSync(path.resolve(repoRoot, safeFile), "utf-8").split(/\r?\n/);
		const startIndex = Math.max(0, root.line - 1);
		const direct = lines[startIndex];
		if (direct) {
			const index = direct.indexOf(root.name);
			if (index >= 0) return { line: root.line, column: index + 1 };
		}
		const declarationPattern = new RegExp(`\\b(?:def|class)\\s+${escapeRegExp(root.name)}\\b`);
		for (let index = startIndex; index < Math.min(lines.length, startIndex + 20); index++) {
			const line = lines[index] ?? "";
			const match = declarationPattern.exec(line);
			if (match?.index !== undefined) {
				const nameIndex = line.indexOf(root.name, match.index);
				return { line: index + 1, column: nameIndex >= 0 ? nameIndex + 1 : match.index + 1 };
			}
			const nameIndex = line.indexOf(root.name);
			if (nameIndex >= 0) return { line: index + 1, column: nameIndex + 1 };
		}
	} catch {
		// Fall through to the parser-provided location.
	}
	return { line: root.line, column: root.column };
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
		evidence: pyreflyReferenceEvidence,
	};
}

async function pyreflyVersion(executable: string, cwd: string, timeoutMs: number): Promise<string | undefined> {
	const result = await runCommand(executable, ["--version"], { cwd, timeoutMs: Math.min(timeoutMs, 5_000), maxOutputBytes: 20_000 });
	if (commandDiagnostic(result)) return undefined;
	return result.stdout.split(/\r?\n/).find(Boolean);
}

async function confirmPyreflyRoots(roots: ReferenceRoot[], context: ReferenceConfirmationContext, options: ReferenceConfirmationOptions, limits: ReferenceConfirmationLimits) {
	const executable = findExecutable("pyrefly");
	if (!executable) return { roots: [], references: [], diagnostics: [pyreflyMetadata.missingDiagnostic], limitations: pyreflyMetadata.limitations };
	const workspaceRoot = pyreflyWorkspaceRoot(context.repoRoot, roots.map((root) => root.file));
	const diagnostics: string[] = [];
	const confirmedRoots: Record<string, unknown>[] = [];
	const references: Record<string, unknown>[] = [];
	const session = new LspSession({ command: executable, args: ["lsp"], cwd: workspaceRoot, repoRoot: context.repoRoot, rootUri: pathToFileURL(workspaceRoot).href, timeoutMs: limits.timeoutMs, signal: context.signal, name: "pyrefly" });
	try {
		const init = await session.initialize();
		if (init.error) diagnostics.push(`initialize: ${init.error.message ?? "pyrefly error"}`);
		for (const root of roots) {
			if (references.length >= limits.maxResults) break;
			let safeFile: string;
			try {
				safeFile = ensureInsideRoot(context.repoRoot, root.file);
			} catch (error) {
				diagnostics.push(`${root.name}: ${error instanceof Error ? error.message : String(error)}`);
				continue;
			}
			const position = symbolPosition(context.repoRoot, { ...root, file: safeFile });
			const document = session.didOpen(safeFile, "python");
			const response = await session.references(document, position.line - 1, Math.max(0, position.column - 1), options.includeDeclarations === true);
			confirmedRoots.push({ symbol: root.name, file: safeFile, line: position.line, column: position.column, kind: root.kind, position: `${safeFile}:${position.line}:${position.column}` });
			if (response.error) {
				diagnostics.push(`${root.name}: ${response.error.message ?? "pyrefly references error"}`);
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
	const version = await pyreflyVersion(executable, workspaceRoot, limits.timeoutMs);
	return { executable, roots: confirmedRoots, references, diagnostics, limitations: pyreflyMetadata.limitations, version, workspaceRoot: ensureInsideRoot(context.repoRoot, workspaceRoot) };
}

export const pyreflyReferenceProvider: ReferenceConfirmationProvider = {
	name: "pyrefly",
	evidence: pyreflyReferenceEvidence,
	supportedLanguages: pyreflyMetadata.supportedLanguages,
	missingDiagnostic: pyreflyMetadata.missingDiagnostic,
	noRootsDiagnostic: pyreflyMetadata.noRootsDiagnostic ?? "No Python roots with current-source definition locations were available for Pyrefly confirmation.",
	limitations: pyreflyMetadata.limitations,
	confirmRoots: confirmPyreflyRoots,
};

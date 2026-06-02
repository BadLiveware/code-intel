import * as fs from "node:fs";
import * as path from "node:path";
import { commandDiagnostic, findExecutable, runCommand } from "../../exec.ts";
import { ensureInsideRoot } from "../../repo.ts";
import { referenceProviderMetadata } from "../provider-metadata.ts";
import type { ReferenceConfirmationContext, ReferenceConfirmationLimits, ReferenceConfirmationOptions, ReferenceConfirmationProvider, ReferenceRoot } from "../types.ts";

const goplsMetadata = referenceProviderMetadata("gopls");
const goplsReferenceEvidence = goplsMetadata.evidence.references ?? "gopls:references";

function symbolColumn(repoRoot: string, root: ReferenceRoot): number {
	try {
		const safeFile = ensureInsideRoot(repoRoot, root.file);
		const absoluteFile = path.resolve(repoRoot, safeFile);
		const line = fs.readFileSync(absoluteFile, "utf-8").split(/\r?\n/)[root.line - 1];
		if (!line) return root.column;
		const index = line.indexOf(root.name);
		return index >= 0 ? index + 1 : root.column;
	} catch {
		return root.column;
	}
}

function parseGoplsReferenceLine(repoRoot: string, line: string): Record<string, unknown> | undefined {
	const match = /^(.*):(\d+):(\d+)(?:-(\d+))?$/.exec(line.trim());
	if (!match) return undefined;
	const absoluteFile = path.isAbsolute(match[1]) ? match[1] : path.resolve(repoRoot, match[1]);
	let file: string;
	try {
		file = ensureInsideRoot(repoRoot, absoluteFile);
	} catch {
		return undefined;
	}
	return {
		file,
		line: Number(match[2]),
		column: Number(match[3]),
		endColumn: match[4] ? Number(match[4]) : undefined,
	};
}

async function confirmGoplsRoots(roots: ReferenceRoot[], context: ReferenceConfirmationContext, options: ReferenceConfirmationOptions, limits: ReferenceConfirmationLimits) {
	const executable = findExecutable("gopls");
	if (!executable) {
		return { roots: [], references: [], diagnostics: [goplsMetadata.missingDiagnostic], limitations: goplsMetadata.limitations };
	}

	const confirmedRoots: Record<string, unknown>[] = [];
	const references: Record<string, unknown>[] = [];
	const diagnostics: string[] = [];
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
		const position = `${safeFile}:${root.line}:${column}`;
		const args = ["references", ...(options.includeDeclarations === true ? ["-d"] : []), position];
		const result = await runCommand(executable, args, { cwd: context.repoRoot, timeoutMs: limits.timeoutMs, maxOutputBytes: Math.min(context.config.maxOutputBytes, 500_000), signal: context.signal });
		const diagnostic = commandDiagnostic(result);
		confirmedRoots.push({ symbol: root.name, file: safeFile, line: root.line, column, kind: root.kind, position });
		if (diagnostic) {
			diagnostics.push(`${root.name}: ${diagnostic}`);
			continue;
		}
		for (const outputLine of result.stdout.split(/\r?\n/)) {
			if (references.length >= limits.maxResults) break;
			const reference = parseGoplsReferenceLine(context.repoRoot, outputLine);
			if (!reference) continue;
			references.push({ ...reference, rootSymbol: root.name, evidence: goplsReferenceEvidence });
		}
	}

	return { executable, roots: confirmedRoots, references, diagnostics, limitations: goplsMetadata.limitations };
}

export const goplsReferenceProvider: ReferenceConfirmationProvider = {
	name: "gopls",
	evidence: goplsReferenceEvidence,
	supportedLanguages: goplsMetadata.supportedLanguages,
	missingDiagnostic: goplsMetadata.missingDiagnostic,
	noRootsDiagnostic: goplsMetadata.noRootsDiagnostic ?? "No Go roots with current-source definition locations were available for gopls confirmation.",
	limitations: goplsMetadata.limitations,
	confirmRoots: confirmGoplsRoots,
};

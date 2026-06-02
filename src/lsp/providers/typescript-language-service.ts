import * as fs from "node:fs";
import * as path from "node:path";
import * as ts from "typescript";
import { ensureInsideRoot } from "../../repo.ts";
import { referenceProviderMetadata } from "../provider-metadata.ts";
import type { ReferenceConfirmationContext, ReferenceConfirmationLimits, ReferenceConfirmationOptions, ReferenceConfirmationProvider, ReferenceRoot } from "../types.ts";

const typescriptMetadata = referenceProviderMetadata("typescript");
const typescriptReferenceEvidence = typescriptMetadata.evidence.references ?? "typescript:references";

const TS_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const EXCLUDED_DIRS = new Set([".git", "node_modules", "dist", "build", "coverage", ".next", ".turbo", ".cache"]);

function collectTypeScriptFiles(repoRoot: string): string[] {
	const files: string[] = [];
	const stack = [repoRoot];
	while (stack.length > 0) {
		const current = stack.pop() as string;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(current, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const absolute = path.join(current, entry.name);
			if (entry.isDirectory()) {
				if (!EXCLUDED_DIRS.has(entry.name)) stack.push(absolute);
			} else if (entry.isFile() && TS_EXTENSIONS.has(path.extname(entry.name))) files.push(absolute);
		}
	}
	return files.sort();
}

function configPathForRoots(repoRoot: string, roots: ReferenceRoot[]): string | undefined {
	for (const root of roots) {
		try {
			const safeFile = ensureInsideRoot(repoRoot, root.file);
			const configPath = ts.findConfigFile(path.dirname(path.resolve(repoRoot, safeFile)), ts.sys.fileExists, "tsconfig.json");
			if (configPath) {
				ensureInsideRoot(repoRoot, configPath);
				return configPath;
			}
		} catch {
			// Try the next root, then fall back to repo root discovery.
		}
	}
	const repoConfigPath = ts.findConfigFile(repoRoot, ts.sys.fileExists, "tsconfig.json");
	if (!repoConfigPath) return undefined;
	try {
		ensureInsideRoot(repoRoot, repoConfigPath);
		return repoConfigPath;
	} catch {
		return undefined;
	}
}

function compilerOptions(repoRoot: string, roots: ReferenceRoot[]): { files: string[]; options: ts.CompilerOptions } {
	const configPath = configPathForRoots(repoRoot, roots);
	if (configPath) {
		const config = ts.readConfigFile(configPath, ts.sys.readFile);
		if (!config.error) {
			const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath));
			return { files: parsed.fileNames.filter((file) => TS_EXTENSIONS.has(path.extname(file))), options: { ...parsed.options, allowJs: true } };
		}
	}
	return {
		files: collectTypeScriptFiles(repoRoot),
		options: {
			allowJs: true,
			checkJs: false,
			jsx: ts.JsxEmit.Preserve,
			module: ts.ModuleKind.ESNext,
			moduleResolution: ts.ModuleResolutionKind.Node10,
			target: ts.ScriptTarget.ES2022,
		},
	};
}

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

function createLanguageService(repoRoot: string, roots: ReferenceRoot[]): { service: ts.LanguageService; files: string[]; versions: Map<string, string> } {
	const project = compilerOptions(repoRoot, roots);
	const files = project.files.map((file) => path.resolve(file));
	const versions = new Map(files.map((file) => [file, "0"]));
	const host: ts.LanguageServiceHost = {
		getScriptFileNames: () => files,
		getScriptVersion: (fileName) => versions.get(path.resolve(fileName)) ?? "0",
		getScriptSnapshot: (fileName) => {
			try {
				return ts.ScriptSnapshot.fromString(fs.readFileSync(fileName, "utf-8"));
			} catch {
				return undefined;
			}
		},
		getCurrentDirectory: () => repoRoot,
		getCompilationSettings: () => project.options,
		getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
		fileExists: ts.sys.fileExists,
		readFile: ts.sys.readFile,
		readDirectory: ts.sys.readDirectory,
		directoryExists: ts.sys.directoryExists,
		getDirectories: ts.sys.getDirectories,
	};
	return { service: ts.createLanguageService(host, ts.createDocumentRegistry()), files, versions };
}

function positionForRoot(repoRoot: string, root: ReferenceRoot, service: ts.LanguageService): { file: string; position: number; column: number } | undefined {
	let safeFile: string;
	try {
		safeFile = ensureInsideRoot(repoRoot, root.file);
	} catch {
		return undefined;
	}
	const absoluteFile = path.resolve(repoRoot, safeFile);
	const program = service.getProgram();
	const sourceFile = program?.getSourceFile(absoluteFile);
	if (!sourceFile) return undefined;
	const column = symbolColumn(repoRoot, { ...root, file: safeFile });
	return { file: absoluteFile, column, position: ts.getPositionOfLineAndCharacter(sourceFile, root.line - 1, column - 1) };
}

function referenceLocation(repoRoot: string, entry: ts.ReferenceEntry): Record<string, unknown> | undefined {
	let file: string;
	try {
		file = ensureInsideRoot(repoRoot, entry.fileName);
	} catch {
		return undefined;
	}
	const source = ts.sys.readFile(entry.fileName);
	if (!source) return undefined;
	const sourceFile = ts.createSourceFile(entry.fileName, source, ts.ScriptTarget.Latest, false);
	const start = sourceFile.getLineAndCharacterOfPosition(entry.textSpan.start);
	return {
		file,
		line: start.line + 1,
		column: start.character + 1,
		endColumn: start.character + entry.textSpan.length + 1,
	};
}

async function confirmTypeScriptRoots(roots: ReferenceRoot[], context: ReferenceConfirmationContext, options: ReferenceConfirmationOptions, limits: ReferenceConfirmationLimits) {
	let service: ts.LanguageService;
	let files: string[];
	try {
		({ service, files } = createLanguageService(context.repoRoot, roots));
	} catch (error) {
		return { roots: [], references: [], diagnostics: [`TypeScript language service setup failed: ${error instanceof Error ? error.message : String(error)}`], limitations: typescriptMetadata.limitations };
	}
	if (files.length === 0) return { roots: [], references: [], diagnostics: ["No TypeScript/JavaScript files were available for TypeScript reference confirmation."], limitations: typescriptMetadata.limitations };

	const confirmedRoots: Record<string, unknown>[] = [];
	const references: Record<string, unknown>[] = [];
	const diagnostics: string[] = [];
	for (const root of roots) {
		if (references.length >= limits.maxResults) break;
		const position = positionForRoot(context.repoRoot, root, service);
		if (!position) {
			diagnostics.push(`${root.name}: TypeScript source file not available for ${root.file}`);
			continue;
		}
		confirmedRoots.push({ symbol: root.name, file: ensureInsideRoot(context.repoRoot, root.file), line: root.line, column: position.column, kind: root.kind, position: `${ensureInsideRoot(context.repoRoot, root.file)}:${root.line}:${position.column}` });
		const entries = service.getReferencesAtPosition(position.file, position.position) ?? [];
		for (const entry of entries) {
			if (references.length >= limits.maxResults) break;
			const reference = referenceLocation(context.repoRoot, entry);
			if (!reference) continue;
			const isRootDefinition = reference.file === ensureInsideRoot(context.repoRoot, root.file) && reference.line === root.line && reference.column === position.column;
			const definitionFlag = (entry as ts.ReferenceEntry & { isDefinition?: boolean }).isDefinition === true || isRootDefinition;
			if (definitionFlag && options.includeDeclarations !== true) continue;
			references.push({ ...reference, rootSymbol: root.name, evidence: typescriptReferenceEvidence, isDefinition: definitionFlag });
		}
	}
	service.dispose();

	return { roots: confirmedRoots, references, diagnostics, limitations: typescriptMetadata.limitations };
}

export const typescriptReferenceProvider: ReferenceConfirmationProvider = {
	name: "typescript",
	evidence: typescriptReferenceEvidence,
	supportedLanguages: typescriptMetadata.supportedLanguages,
	missingDiagnostic: typescriptMetadata.missingDiagnostic,
	noRootsDiagnostic: typescriptMetadata.noRootsDiagnostic ?? "No TypeScript/JavaScript roots with current-source definition locations were available for TypeScript reference confirmation.",
	limitations: typescriptMetadata.limitations,
	confirmRoots: confirmTypeScriptRoots,
};

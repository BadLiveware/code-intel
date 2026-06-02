import * as fs from "node:fs";
import * as path from "node:path";
import { LANGUAGE_SPECS, languageSpec, type LanguageSpec } from "../languages.ts";
import { ensureInsideRoot } from "../repo.ts";
import { parserFor } from "./loader.ts";
import type { ParsedFile, ParserBundle, TreeSitterNode } from "./nodes.ts";

const EXCLUDED_DIRS = new Set([".git", ".hg", ".svn", "node_modules", "vendor", "dist", "build", "target", ".cache"]);

function isIgnoredDir(name: string): boolean {
	return EXCLUDED_DIRS.has(name) || name.startsWith("externals.");
}

function repoRelative(repoRoot: string, absoluteFile: string): string {
	return path.relative(repoRoot, absoluteFile).split(path.sep).join(path.posix.sep);
}

function globToRegExp(glob: string): RegExp {
	const normalized = glob.startsWith("!") ? glob.slice(1) : glob;
	let output = "^";
	for (let index = 0; index < normalized.length; index++) {
		const char = normalized[index];
		const next = normalized[index + 1];
		if (char === "*" && next === "*") {
			output += ".*";
			index++;
		} else if (char === "*") output += "[^/]*";
		else if (char === "?") output += "[^/]";
		else output += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
	}
	return new RegExp(`${output}$`);
}

function matchesGlob(file: string, globs: string[]): boolean {
	return globs.some((glob) => globToRegExp(glob).test(file));
}

function shouldIncludeFile(file: string, includeGlobs: string[], excludeGlobs: string[]): boolean {
	const normalizedExcludes = excludeGlobs.map((glob) => glob.startsWith("!") ? glob.slice(1) : glob);
	if (includeGlobs.length > 0 && !matchesGlob(file, includeGlobs)) return false;
	if (normalizedExcludes.length > 0 && matchesGlob(file, normalizedExcludes)) return false;
	return true;
}

function specsForLanguages(languages: string[], diagnostics: string[]): LanguageSpec[] {
	const specs: LanguageSpec[] = [];
	const seen = new Set<string>();
	for (const language of languages) {
		const spec = languageSpec(language);
		if (!spec) {
			diagnostics.push(`Unsupported Tree-sitter language: ${language}`);
			continue;
		}
		if (seen.has(spec.id)) continue;
		seen.add(spec.id);
		specs.push(spec);
	}
	return specs;
}

function extensionSpecMap(specs: LanguageSpec[]): Map<string, LanguageSpec[]> {
	const extensions = new Map<string, LanguageSpec[]>();
	for (const spec of specs) {
		for (const extension of spec.extensions) {
			const bucket = extensions.get(extension) ?? [];
			bucket.push(spec);
			extensions.set(extension, bucket);
		}
	}
	return extensions;
}

function emptyFileGroups(specs: LanguageSpec[]): Map<string, Set<string>> {
	return new Map(specs.map((spec) => [spec.id, new Set<string>()]));
}

function collectFilesForSpecs(repoRoot: string, specs: LanguageSpec[], paths: string[], includeGlobs: string[] = [], excludeGlobs: string[] = []): Map<string, string[]> {
	const filesBySpec = emptyFileGroups(specs);
	const specsByExtension = extensionSpecMap(specs);
	const roots = paths.length > 0 ? paths : ["."];
	const stack: string[] = [];

	const addFile = (absoluteFile: string): void => {
		const matchingSpecs = specsByExtension.get(path.extname(absoluteFile));
		if (!matchingSpecs) return;
		const relative = repoRelative(repoRoot, absoluteFile);
		if (!shouldIncludeFile(relative, includeGlobs, excludeGlobs)) return;
		for (const spec of matchingSpecs) filesBySpec.get(spec.id)?.add(absoluteFile);
	};

	for (const inputPath of roots) {
		const safe = ensureInsideRoot(repoRoot, inputPath);
		const absolute = path.resolve(repoRoot, safe);
		if (!fs.existsSync(absolute)) continue;
		const stat = fs.statSync(absolute);
		if (stat.isDirectory()) stack.push(absolute);
		else if (stat.isFile()) addFile(absolute);
	}

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
				if (!isIgnoredDir(entry.name)) stack.push(absolute);
			} else if (entry.isFile()) addFile(absolute);
		}
	}

	return new Map([...filesBySpec.entries()].map(([language, files]) => [language, [...files].sort()]));
}

export async function parseFiles(repoRoot: string, languages: string[], paths: string[] = [], includeGlobs: string[] = [], excludeGlobs: string[] = [], timeoutMs = 30_000, signal?: AbortSignal): Promise<{ parsedFiles: ParsedFile[]; diagnostics: string[]; filesByLanguage: Record<string, number>; parsedByLanguage: Record<string, number> }> {
	const started = Date.now();
	const diagnostics: string[] = [];
	const parsedFiles: ParsedFile[] = [];
	const filesByLanguage: Record<string, number> = {};
	const parsedByLanguage: Record<string, number> = {};
	const specs = specsForLanguages(languages, diagnostics);
	const filesBySpec = collectFilesForSpecs(repoRoot, specs, paths, includeGlobs, excludeGlobs);
	for (const spec of specs) {
		let bundle: ParserBundle;
		try {
			bundle = await parserFor(spec);
		} catch (error) {
			diagnostics.push(`Could not initialize Tree-sitter ${spec.id}: ${error instanceof Error ? error.message : String(error)}`);
			continue;
		}
		const files = filesBySpec.get(spec.id) ?? [];
		filesByLanguage[spec.id] = files.length;
		for (const absoluteFile of files) {
			if (signal?.aborted) break;
			if (Date.now() - started > timeoutMs) {
				diagnostics.push("Tree-sitter scan timed out before all files were parsed");
				return { parsedFiles, diagnostics, filesByLanguage, parsedByLanguage };
			}
			try {
				const source = fs.readFileSync(absoluteFile, "utf8");
				const tree = bundle.parser.parse(source);
				parsedFiles.push({ file: repoRelative(repoRoot, absoluteFile), absoluteFile, source, language: spec.id, root: tree.rootNode as TreeSitterNode, bundle });
				parsedByLanguage[spec.id] = (parsedByLanguage[spec.id] ?? 0) + 1;
			} catch (error) {
				diagnostics.push(`${repoRelative(repoRoot, absoluteFile)}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}
	return { parsedFiles, diagnostics, filesByLanguage, parsedByLanguage };
}

export function readSourceFileAsParsed(repoRoot: string, file: string, language: string): ParsedFile {
	const absoluteFile = path.resolve(repoRoot, file);
	const source = fs.readFileSync(absoluteFile, "utf8");
	const lines = source.split(/\r?\n/);
	const root: TreeSitterNode = {
		type: "source_file",
		startIndex: 0,
		endIndex: source.length,
		startPosition: { row: 0, column: 0 },
		endPosition: { row: Math.max(0, lines.length - 1), column: lines.at(-1)?.length ?? 0 },
		namedChildCount: 0,
		namedChild: () => null,
		childForFieldName: () => null,
	};
	return { file, absoluteFile, source, language, root, bundle: { parser: undefined, language: undefined, spec: { id: language, wasm: "", extensions: [] } } };
}

export function languagesForSyntaxSearch(language: string | undefined, paths: string[]): string[] {
	if (language?.trim()) return [language.trim()];
	const pathExtensions = paths.map((item) => path.extname(item)).filter(Boolean);
	const inferred = LANGUAGE_SPECS.filter((spec) => spec.extensions.some((extension) => pathExtensions.includes(extension))).map((spec) => spec.id);
	return inferred.length > 0 ? [...new Set(inferred)] : ["go"];
}

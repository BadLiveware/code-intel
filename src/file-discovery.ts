import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { ensureInsideRoot } from "./repo.ts";

export interface RepoFile {
	file: string;
	absolute: string;
}

export interface RepoFileDiscoveryResult {
	roots: string[];
	files: RepoFile[];
	truncated: boolean;
	gitIgnoreApplied: boolean;
	explicitIgnoredPathScanned: boolean;
	excludedDirs: Record<string, number>;
}

export interface RepoFileDiscoveryOptions {
	paths?: string[];
	includeGlobs?: string[];
	excludeGlobs?: string[];
	includeIgnored?: boolean;
	excludedDirNames?: ReadonlySet<string>;
	maxFiles?: number;
	timeoutMs?: number;
	diagnostics?: string[];
	signal?: AbortSignal;
}

function posixPath(value: string): string {
	return value.split(path.sep).join(path.posix.sep);
}

function repoRelative(repoRoot: string, absoluteFile: string): string {
	return posixPath(path.relative(repoRoot, absoluteFile));
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

export function includeByGlobs(file: string, includeGlobs: string[] = [], excludeGlobs: string[] = []): boolean {
	const excludes = excludeGlobs.map((glob) => glob.startsWith("!") ? glob.slice(1) : glob);
	if (includeGlobs.length > 0 && !matchesGlob(file, includeGlobs)) return false;
	return excludes.length === 0 || !matchesGlob(file, excludes);
}

function gitVisibleFiles(repoRoot: string, timeoutMs: number | undefined, diagnostics: string[]): string[] | undefined {
	try {
		const stdout = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], {
			cwd: repoRoot,
			encoding: "utf8",
			maxBuffer: 50 * 1024 * 1024,
			timeout: timeoutMs,
		});
		return stdout.split("\0").map((file) => file.trim()).filter(Boolean).map(posixPath).sort();
	} catch (error) {
		diagnostics.push(`git ls-files --exclude-standard unavailable; falling back to filesystem scan: ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	}
}

function fileIsUnderRoot(file: string, root: string): boolean {
	if (root === "." || root === "") return true;
	return file === root || file.startsWith(`${root.replace(/\/$/, "")}/`);
}

function safeRoots(repoRoot: string, paths: string[] | undefined, diagnostics: string[]): string[] {
	const roots = paths && paths.length > 0 ? paths : ["."];
	const output: string[] = [];
	for (const item of roots) {
		try {
			output.push(ensureInsideRoot(repoRoot, item));
		} catch (error) {
			diagnostics.push(`${item}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return output;
}

export function collectRepoFiles(repoRoot: string, options: RepoFileDiscoveryOptions = {}): RepoFileDiscoveryResult {
	const diagnostics = options.diagnostics ?? [];
	const roots = safeRoots(repoRoot, options.paths, diagnostics);
	const includeGlobs = options.includeGlobs ?? [];
	const excludeGlobs = options.excludeGlobs ?? [];
	const maxFiles = options.maxFiles ?? Number.POSITIVE_INFINITY;
	const excludedDirs = options.excludedDirNames ?? new Set<string>();
	const skippedDirs: Record<string, number> = {};
	const files = new Map<string, RepoFile>();
	let truncated = false;
	let explicitIgnoredPathScanned = false;
	const started = Date.now();
	const gitFiles = options.includeIgnored === true ? undefined : gitVisibleFiles(repoRoot, options.timeoutMs, diagnostics);

	const addFile = (file: string, absolute: string): void => {
		if (truncated || !includeByGlobs(file, includeGlobs, excludeGlobs)) return;
		files.set(file, { file, absolute });
		if (files.size >= maxFiles) truncated = true;
	};

	const scanDirectory = (absoluteDir: string): void => {
		if (truncated || options.signal?.aborted) {
			truncated = true;
			return;
		}
		if (options.timeoutMs && Date.now() - started > options.timeoutMs) {
			truncated = true;
			diagnostics.push("Repository file discovery stopped before all paths were visited");
			return;
		}
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(absoluteDir, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
		} catch (error) {
			diagnostics.push(`${repoRelative(repoRoot, absoluteDir)}: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		for (const entry of entries) {
			if (truncated) break;
			const absolute = path.join(absoluteDir, entry.name);
			if (entry.isDirectory()) {
				if (excludedDirs.has(entry.name)) {
					skippedDirs[entry.name] = (skippedDirs[entry.name] ?? 0) + 1;
					continue;
				}
				scanDirectory(absolute);
			} else if (entry.isFile()) {
				const file = repoRelative(repoRoot, absolute);
				if (!file) continue;
				addFile(file, absolute);
			}
		}
	};

	for (const root of roots) {
		if (truncated) break;
		const absolute = path.resolve(repoRoot, root);
		if (!fs.existsSync(absolute)) {
			diagnostics.push(`${root}: path does not exist`);
			continue;
		}
		const stat = fs.statSync(absolute);
		if (stat.isFile()) {
			// A named file is intentional and remains inspectable even when git ignores it.
			addFile(root, absolute);
			continue;
		}
		if (!stat.isDirectory()) continue;
		if (gitFiles) {
			const matched = gitFiles.filter((file) => fileIsUnderRoot(file, root));
			if (matched.length > 0 || root === ".") {
				for (const file of matched) {
					if (truncated) break;
					addFile(file, path.resolve(repoRoot, file));
				}
				continue;
			}
			// An explicit directory with no git-visible files may be ignored. Scan it so
			// callers can inspect generated outputs such as obj/**/*.g.cs deliberately.
			explicitIgnoredPathScanned = true;
		}
		scanDirectory(absolute);
	}

	return {
		roots,
		files: [...files.values()].sort((left, right) => left.file.localeCompare(right.file)),
		truncated,
		gitIgnoreApplied: Boolean(gitFiles),
		explicitIgnoredPathScanned,
		excludedDirs: skippedDirs,
	};
}

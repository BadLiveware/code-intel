import * as fs from "node:fs";
import * as path from "node:path";
import type { RepoRoots } from "./types.ts";
import { commandDiagnostic, runCommand } from "./exec.ts";
import { normalizeStringArray } from "./util.ts";

export function normalizeToolPath(input: string): string {
	return input.startsWith("@") ? input.slice(1) : input;
}

export function resolveRequestedRootFromCwd(cwd: string, requested?: string): string {
	if (!requested?.trim()) return cwd;
	return path.resolve(cwd, normalizeToolPath(requested.trim()));
}

interface CwdContext {
	cwd: string;
}

export function resolveRequestedRoot(ctx: CwdContext, requested?: string): string {
	return resolveRequestedRootFromCwd(ctx.cwd, requested);
}

function rootInputDirectory(requestedRoot: string): string {
	try {
		const stat = fs.statSync(requestedRoot);
		return stat.isFile() ? path.dirname(requestedRoot) : requestedRoot;
	} catch {
		return requestedRoot;
	}
}

export function realPathOrSelf(target: string): string {
	try {
		return fs.realpathSync(target);
	} catch {
		return path.resolve(target);
	}
}

export async function resolveRepoRootsFromCwd(cwd: string, requested?: string, timeoutMs = 5_000): Promise<RepoRoots> {
	const requestedRoot = resolveRequestedRootFromCwd(cwd, requested);
	const rootCwd = rootInputDirectory(requestedRoot);
	const diagnostics: string[] = [];
	if (!fs.existsSync(rootCwd)) diagnostics.push(`Path does not exist: ${rootCwd}`);
	const git = await runCommand("git", ["rev-parse", "--show-toplevel"], { cwd: rootCwd, timeoutMs, maxOutputBytes: 100_000 });
	if (git.exitCode === 0 && git.stdout.trim()) {
		return { requestedRoot, repoRoot: path.resolve(git.stdout.trim()), diagnostics };
	}
	if (git.error && git.error !== "ENOENT") diagnostics.push(`git repo detection failed: ${git.error}`);
	return { requestedRoot, repoRoot: path.resolve(rootCwd), diagnostics };
}

export async function resolveRepoRoots(ctx: CwdContext, requested?: string, timeoutMs = 5_000): Promise<RepoRoots> {
	return resolveRepoRootsFromCwd(ctx.cwd, requested, timeoutMs);
}

export function ensureInsideRoot(repoRoot: string, requestedPath: string): string {
	const resolved = path.resolve(repoRoot, normalizeToolPath(requestedPath));
	const relative = path.relative(repoRoot, resolved);
	if (relative === "") return ".";
	if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new Error(`Path is outside repository root: ${requestedPath}`);
	}
	return relative.split(path.sep).join(path.posix.sep);
}

export function pathArgsForRepo(repoRoot: string, requestedPaths: string[] | undefined): string[] {
	const paths = normalizeStringArray(requestedPaths);
	if (paths.length === 0) return ["."];
	return paths.map((item) => ensureInsideRoot(repoRoot, item));
}

export async function changedFilesFromBase(repoRoot: string, baseRef: string | undefined, queryTimeoutMs: number, maxOutputBytes: number): Promise<{ files: string[]; diagnostic?: string }> {
	if (!baseRef?.trim()) return { files: [] };
	const result = await runCommand("git", ["diff", "--name-only", baseRef.trim(), "--"], { cwd: repoRoot, timeoutMs: queryTimeoutMs, maxOutputBytes });
	if (result.exitCode !== 0) return { files: [], diagnostic: commandDiagnostic(result) };
	return { files: result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) };
}

import * as fs from "node:fs";
import * as path from "node:path";
import { ensureInsideRoot, normalizeToolPath } from "../repo.ts";
import type { CodeIntelEnv } from "./env.ts";

export type CodeIntelPathBase = "auto" | "cwd" | "repo";

type PathField = "path" | "paths" | "changedFiles" | "testPaths";
const pathFields: PathField[] = ["path", "paths", "changedFiles", "testPaths"];

function normalizePathValue(value: unknown, env: CodeIntelEnv, repoRoot: string): unknown {
	if (typeof value !== "string" || !value.trim()) return value;
	const input = normalizeToolPath(value.trim());
	if (input.startsWith("file://")) return value;
	if (path.isAbsolute(input)) return ensureInsideRoot(repoRoot, input);
	if (env.pathBase === "repo") return ensureInsideRoot(repoRoot, input);
	if (env.pathBase === "cwd") return ensureInsideRoot(repoRoot, path.resolve(env.cwd, input));
	const repoCandidate = path.resolve(repoRoot, input);
	if (fs.existsSync(repoCandidate)) return ensureInsideRoot(repoRoot, input);
	return ensureInsideRoot(repoRoot, path.resolve(env.cwd, input));
}

function normalizePathArray(value: unknown, env: CodeIntelEnv, repoRoot: string): unknown {
	if (!Array.isArray(value)) return value;
	return value.map((item) => normalizePathValue(item, env, repoRoot));
}

function normalizeDiagnostics(value: unknown, env: CodeIntelEnv, repoRoot: string): unknown {
	if (!Array.isArray(value)) return value;
	return value.map((item) => {
		if (item === null || typeof item !== "object" || Array.isArray(item)) return item;
		const record = item as Record<string, unknown>;
		if (typeof record.path !== "string") return item;
		return { ...record, path: normalizePathValue(record.path, env, repoRoot) };
	});
}

export function normalizeStandalonePathParams<T extends Record<string, unknown>>(params: T, env: CodeIntelEnv, repoRoot: string): T {
	if (env.pathBase === "repo") return params;
	let changed = false;
	const next: Record<string, unknown> = { ...params };
	for (const field of pathFields) {
		if (!(field in params)) continue;
		const value = params[field];
		const normalized = field === "path" ? normalizePathValue(value, env, repoRoot) : normalizePathArray(value, env, repoRoot);
		if (normalized !== value) {
			next[field] = normalized;
			changed = true;
		}
	}
	if ("diagnostics" in params) {
		const normalized = normalizeDiagnostics(params.diagnostics, env, repoRoot);
		if (normalized !== params.diagnostics) {
			next.diagnostics = normalized;
			changed = true;
		}
	}
	return changed ? next as T : params;
}

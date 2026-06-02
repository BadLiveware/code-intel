import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_CONFIG, type CodeIntelConfig, type LoadedConfig } from "../types.ts";
import { isRecord, normalizePositiveInteger } from "../util.ts";
import type { CodeIntelPathBase } from "./path-params.ts";

export type CodeIntelMutationPolicy = "disabled" | "enabled";

export interface CodeIntelEnv {
	cwd: string;
	config: CodeIntelConfig;
	configPaths: LoadedConfig["paths"] & { standaloneUser: string; explicit?: string };
	loadedConfig: string[];
	configDiagnostics: string[];
	mutationPolicy: CodeIntelMutationPolicy;
	pathBase: CodeIntelPathBase;
	persistentLsp: boolean;
}

export interface CodeIntelEnvOptions {
	cwd?: string;
	configPath?: string;
	config?: Partial<CodeIntelConfig>;
	mutationPolicy?: CodeIntelMutationPolicy;
	pathBase?: CodeIntelPathBase;
	persistentLsp?: boolean;
}

function standaloneUserConfigPath(): string {
	return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "code-intelligence", "config.json");
}

function piAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? process.env.PI_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
}

function piUserConfigPath(): string {
	return path.join(piAgentDir(), "code-intelligence.json");
}

function projectConfigPath(cwd: string): string {
	return path.join(cwd, ".pi", "code-intelligence.json");
}

function explicitConfigPath(input: string | undefined, cwd: string): string | undefined {
	if (!input?.trim()) return undefined;
	const normalized = input.trim().startsWith("@") ? input.trim().slice(1) : input.trim();
	return path.resolve(cwd, normalized);
}

function normalizeConfigPatch(input: unknown, base: CodeIntelConfig, source: string, diagnostics: string[]): CodeIntelConfig {
	if (!isRecord(input)) {
		diagnostics.push(`${source}: expected a JSON object`);
		return base;
	}
	return {
		maxResults: normalizePositiveInteger(input.maxResults, base.maxResults, 1, 500),
		queryTimeoutMs: normalizePositiveInteger(input.queryTimeoutMs, base.queryTimeoutMs, 1_000, 600_000),
		maxOutputBytes: normalizePositiveInteger(input.maxOutputBytes, base.maxOutputBytes, 10_000, 50_000_000),
	};
}

function loadConfigFile(configPath: string, config: CodeIntelConfig, loaded: string[], diagnostics: string[]): CodeIntelConfig {
	if (!fs.existsSync(configPath)) return config;
	try {
		const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8")) as unknown;
		loaded.push(configPath);
		return normalizeConfigPatch(parsed, config, configPath, diagnostics);
	} catch (error) {
		diagnostics.push(`${configPath}: ${error instanceof Error ? error.message : String(error)}`);
		return config;
	}
}

export function loadStandaloneConfig(cwd: string, configPath?: string, overlay?: Partial<CodeIntelConfig>): Omit<CodeIntelEnv, "cwd" | "mutationPolicy" | "pathBase" | "persistentLsp"> {
	let config: CodeIntelConfig = { ...DEFAULT_CONFIG };
	const explicit = explicitConfigPath(configPath ?? process.env.CODE_INTEL_CONFIG, cwd);
	const paths = {
		user: piUserConfigPath(),
		project: projectConfigPath(cwd),
		standaloneUser: standaloneUserConfigPath(),
		explicit,
	};
	const loaded: string[] = [];
	const diagnostics: string[] = [];
	for (const candidate of [paths.user, paths.standaloneUser, paths.project, paths.explicit]) {
		if (!candidate) continue;
		config = loadConfigFile(candidate, config, loaded, diagnostics);
	}
	if (overlay) config = normalizeConfigPatch(overlay, config, "inline config", diagnostics);
	return { config, configPaths: paths, loadedConfig: loaded, configDiagnostics: diagnostics };
}

export function createCodeIntelEnv(options: CodeIntelEnvOptions = {}): CodeIntelEnv {
	const cwd = path.resolve(options.cwd ?? process.cwd());
	const loaded = loadStandaloneConfig(cwd, options.configPath, options.config);
	return {
		cwd,
		...loaded,
		mutationPolicy: options.mutationPolicy ?? "disabled",
		pathBase: options.pathBase ?? "auto",
		persistentLsp: options.persistentLsp === true,
	};
}

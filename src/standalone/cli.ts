#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { codeIntelToolSpec, listCodeIntelToolSpecs, runCodeIntelTool } from "../tool-registry.ts";
import { createCodeIntelEnv, type CodeIntelMutationPolicy } from "./env.ts";
import type { CodeIntelPathBase } from "./path-params.ts";
import { runCodeIntelMcpServer } from "./mcp.ts";

interface CliOptions {
	cwd?: string;
	configPath?: string;
	format: "compact" | "json";
	mutationPolicy: CodeIntelMutationPolicy;
	pathBase: CodeIntelPathBase;
}

function usage(): string {
	return `code-intel standalone code intelligence\n\nUsage:\n  code-intel call <tool> --json '<params>' [--format compact|json] [--cwd <dir>] [--config <file>] [--path-base auto|cwd|repo] [--enable-mutations]\n  code-intel mcp [--cwd <dir>] [--config <file>] [--path-base auto|cwd|repo] [--enable-mutations]\n  code-intel list [--enable-mutations]\n\nExamples:\n  code-intel call code_intel_impact_map --json '{"changedFiles":["src/index.ts"]}'\n  code-intel mcp --cwd /path/to/repo\n`;
}

function readJsonArgument(value: string | undefined): Record<string, unknown> {
	if (!value) return {};
	const raw = value.startsWith("@") ? fs.readFileSync(path.resolve(value.slice(1)), "utf-8") : value;
	const parsed = JSON.parse(raw) as unknown;
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("--json must be a JSON object");
	return parsed as Record<string, unknown>;
}

function parseGlobalOptions(args: string[]): { rest: string[]; options: CliOptions; jsonInput?: string } {
	const rest: string[] = [];
	const options: CliOptions = { format: "compact", mutationPolicy: "disabled", pathBase: "auto" };
	let jsonInput: string | undefined;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--cwd") options.cwd = args[++index];
		else if (arg === "--config") options.configPath = args[++index];
		else if (arg === "--format") {
			const value = args[++index];
			if (value !== "compact" && value !== "json") throw new Error("--format must be compact or json");
			options.format = value;
		} else if (arg === "--json") jsonInput = args[++index];
		else if (arg === "--path-base") {
			const value = args[++index];
			if (value !== "auto" && value !== "cwd" && value !== "repo") throw new Error("--path-base must be auto, cwd, or repo");
			options.pathBase = value;
		} else if (arg === "--enable-mutations") options.mutationPolicy = "enabled";
		else if (arg === "--help" || arg === "-h") rest.push("help");
		else rest.push(arg);
	}
	return { rest, options, jsonInput };
}

async function callTool(toolName: string | undefined, jsonInput: string | undefined, options: CliOptions): Promise<void> {
	if (!toolName) throw new Error("call requires a tool name");
	const env = createCodeIntelEnv({ cwd: options.cwd, configPath: options.configPath, mutationPolicy: options.mutationPolicy, pathBase: options.pathBase });
	const params = readJsonArgument(jsonInput);
	const result = await runCodeIntelTool(toolName, params, env);
	if (options.format === "json") {
		process.stdout.write(`${JSON.stringify({ content: [{ type: "text", text: result.contentText }], details: result.details }, null, 2)}\n`);
	} else {
		process.stdout.write(`${result.contentText}\n`);
	}
}

function listTools(options: CliOptions): void {
	const includeMutations = options.mutationPolicy === "enabled";
	for (const spec of listCodeIntelToolSpecs({ includeMutations })) {
		const marker = spec.mutates ? "mutates" : "read-only";
		process.stdout.write(`${spec.name}\t${marker}\t${spec.description}\n`);
	}
}

async function run(argv: string[]): Promise<void> {
	const { rest, options, jsonInput } = parseGlobalOptions(argv);
	const command = rest.shift();
	if (!command || command === "help") {
		process.stdout.write(usage());
		return;
	}
	if (command === "list") {
		listTools(options);
		return;
	}
	if (command === "call") {
		const toolName = rest.shift();
		if (toolName && !codeIntelToolSpec(toolName, { includeMutations: options.mutationPolicy === "enabled" })) throw new Error(`Unknown or unavailable tool: ${toolName}`);
		await callTool(toolName, jsonInput, options);
		return;
	}
	if (command === "mcp") {
		const env = createCodeIntelEnv({ cwd: options.cwd, configPath: options.configPath, mutationPolicy: options.mutationPolicy, pathBase: options.pathBase, persistentLsp: true });
		await runCodeIntelMcpServer(env);
		return;
	}
	throw new Error(`Unknown command: ${command}`);
}

run(process.argv.slice(2)).catch((error) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});

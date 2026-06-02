import { createRequire } from "node:module";
import { commandDiagnostic, findExecutable, firstLine, runCommand } from "../exec.ts";
import type { CodeIntelConfig, LanguageServerName, LanguageServerStatus } from "../types.ts";
import { languageServerProviderMetadata, SEMANTIC_PROVIDER_METADATA } from "./provider-metadata.ts";
import type { SemanticProviderMetadata, SemanticProviderName, SemanticProviderStatus } from "./types.ts";

function baseDetails(metadata: SemanticProviderMetadata): SemanticProviderStatus["details"] {
	return {
		supportedLanguages: metadata.supportedLanguages,
		capabilities: metadata.capabilities,
		evidence: metadata.evidence,
		command: metadata.command,
		commands: metadata.commands,
		packageName: metadata.packageName,
		workspacePrerequisites: metadata.workspacePrerequisites,
		limitations: metadata.limitations,
	};
}

async function commandProviderStatus(metadata: SemanticProviderMetadata, repoRoot: string, config: CodeIntelConfig): Promise<SemanticProviderStatus> {
	const details = baseDetails(metadata);
	const command = metadata.command;
	if (!command) return { provider: metadata.name, label: metadata.label, available: "missing", diagnostics: [metadata.missingDiagnostic], details };
	const executable = findExecutable(command);
	if (!executable) return { provider: metadata.name, label: metadata.label, available: "missing", diagnostics: [metadata.missingDiagnostic], details };
	const args = metadata.versionArgs ?? ["--version"];
	const result = await runCommand(executable, args, { cwd: repoRoot, timeoutMs: Math.min(config.queryTimeoutMs, 10_000), maxOutputBytes: Math.min(config.maxOutputBytes, 200_000) });
	const diagnostic = commandDiagnostic(result);
	return {
		provider: metadata.name,
		label: metadata.label,
		available: diagnostic ? "error" : "available",
		executable,
		version: firstLine(result.stdout || result.stderr),
		diagnostics: diagnostic ? [diagnostic] : [],
		details,
	};
}

function typescriptLibrary(): { path?: string; version?: string; diagnostic?: string } {
	try {
		const require = createRequire(import.meta.url);
		const packageJsonPath = require.resolve("typescript/package.json");
		const packageJson = require(packageJsonPath) as { version?: string };
		return { path: packageJsonPath, version: packageJson.version };
	} catch (error) {
		return { diagnostic: `typescript package not available: ${error instanceof Error ? error.message : String(error)}` };
	}
}

async function typescriptProviderStatus(metadata: SemanticProviderMetadata, repoRoot: string, config: CodeIntelConfig): Promise<SemanticProviderStatus> {
	const details = baseDetails(metadata);
	const library = typescriptLibrary();
	const tsserver = findExecutable("tsserver");
	if (tsserver) return { provider: metadata.name, label: metadata.label, available: "available", executable: tsserver, version: library.version, diagnostics: [], details: { ...details, command: "tsserver", libraryPath: library.path, versionProbe: "not-run" } };
	const tsls = findExecutable("typescript-language-server");
	if (!tsls) {
		if (library.path) return { provider: metadata.name, label: metadata.label, available: "available", version: library.version, diagnostics: [], details: { ...details, command: "typescript-language-service", libraryPath: library.path } };
		return { provider: metadata.name, label: metadata.label, available: "missing", diagnostics: [metadata.missingDiagnostic, ...(library.diagnostic ? [library.diagnostic] : [])], details };
	}
	const result = await runCommand(tsls, ["--version"], { cwd: repoRoot, timeoutMs: Math.min(config.queryTimeoutMs, 10_000), maxOutputBytes: Math.min(config.maxOutputBytes, 200_000) });
	const diagnostic = commandDiagnostic(result);
	return {
		provider: metadata.name,
		label: metadata.label,
		available: diagnostic ? "error" : "available",
		executable: tsls,
		version: firstLine(result.stdout || result.stderr) ?? library.version,
		diagnostics: diagnostic ? [diagnostic] : [],
		details: { ...details, command: "typescript-language-server", libraryPath: library.path },
	};
}

async function semanticProviderStatus(metadata: SemanticProviderMetadata, repoRoot: string, config: CodeIntelConfig): Promise<SemanticProviderStatus> {
	if (metadata.statusKind === "typescript") return typescriptProviderStatus(metadata, repoRoot, config);
	return commandProviderStatus(metadata, repoRoot, config);
}

async function statusesForMetadata(metadataRows: SemanticProviderMetadata[], repoRoot: string, config: CodeIntelConfig): Promise<Array<readonly [SemanticProviderName, SemanticProviderStatus]>> {
	return await Promise.all(metadataRows.map(async (metadata) => [metadata.name, await semanticProviderStatus(metadata, repoRoot, config)] as const));
}

export async function semanticProviderStatuses(repoRoot: string, config: CodeIntelConfig): Promise<Record<SemanticProviderName, SemanticProviderStatus>> {
	return Object.fromEntries(await statusesForMetadata(SEMANTIC_PROVIDER_METADATA, repoRoot, config)) as Record<SemanticProviderName, SemanticProviderStatus>;
}

export async function legacyLanguageServerSemanticProviderStatuses(repoRoot: string, config: CodeIntelConfig): Promise<Record<SemanticProviderName, SemanticProviderStatus>> {
	return Object.fromEntries(await statusesForMetadata(languageServerProviderMetadata(), repoRoot, config)) as Record<SemanticProviderName, SemanticProviderStatus>;
}

export function languageServerStatusesFromProviders(providers: Partial<Record<SemanticProviderName, SemanticProviderStatus>>): Record<LanguageServerName, LanguageServerStatus> {
	const output = {} as Record<LanguageServerName, LanguageServerStatus>;
	for (const metadata of languageServerProviderMetadata()) {
		const status = providers[metadata.name];
		if (!status) continue;
		output[metadata.legacyLanguageServer] = {
			server: metadata.legacyLanguageServer,
			available: status.available,
			executable: status.executable,
			version: status.version,
			diagnostics: status.diagnostics,
			details: status.details,
		};
	}
	return output;
}

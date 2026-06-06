export type { CodeIntelToolResult, CodeIntelToolSpec, JsonObjectSchema } from "./tool-registry.ts";
export { codeIntelToolSpec, listCodeIntelToolSpecs, runCodeIntelTool } from "./tool-registry.ts";

export type { CodeIntelEnv, CodeIntelEnvOptions, CodeIntelMutationPolicy } from "./standalone/env.ts";
export { createCodeIntelEnv, loadStandaloneConfig } from "./standalone/env.ts";

export type {
	BackendName,
	BackendStatus,
	CodeIntelConfig,
	CodeIntelPostEditMapParams,
	CodeIntelStateParams,
	LanguageServerName,
	LanguageServerStatus,
	LoadedConfig,
	RepoRoots,
} from "./types.ts";
export { CONFIG_FILE_NAME, DEFAULT_CONFIG, DEFAULT_MAX_OUTPUT_BYTES, DEFAULT_TIMEOUT_MS } from "./types.ts";

export { changedFilesFromBase, ensureInsideRoot, resolveRepoRoots, resolveRepoRootsFromCwd } from "./repo.ts";

export { impactMapToolSpec } from "./slices/impact-map/spec.ts";
export { localMapToolSpec } from "./slices/local-map/spec.ts";
export { fileOutlineToolSpec, repoOverviewToolSpec, repoRouteToolSpec, testMapToolSpec } from "./slices/orientation/specs.ts";
export { stateToolSpec } from "./slices/state/spec.ts";
export { insertRelativeToolSpec, replaceSymbolToolSpec } from "./slices/symbol-mutations/specs.ts";
export { syntaxSearchToolSpec } from "./slices/syntax-search/spec.ts";
export { postEditMapToolSpec, readSymbolToolSpec } from "./slices/targeted-symbols/specs.ts";

export { backendStatuses, languageServerStatuses, statePayload } from "./slices/state/run.ts";
export {
	languageServerStatusesFromProviders,
	legacyLanguageServerSemanticProviderStatuses,
	semanticProviderStatuses,
} from "./lsp/provider-status.ts";
export { LANGUAGE_CAPABILITIES, LANGUAGE_SPECS } from "./language-support/registry.ts";
export { SEMANTIC_PROVIDER_METADATA } from "./lsp/provider-metadata.ts";

export type { DiagnosticCollectionResult, NormalizedPostEditDiagnostic } from "./slices/post-edit-map/diagnostics.ts";
export { collectTouchedDiagnostics, mergeDiagnostics, normalizePostEditDiagnostics } from "./slices/post-edit-map/diagnostics.ts";

export { extractFileRecords, parseFiles, readSourceFileAsParsed } from "./tree-sitter.ts";
export { rangeLineCount, sliceLines } from "./source-range.ts";
export type { SourceRange } from "./source-range.ts";
export { JsonRpcClient } from "./lsp/json-rpc-client.ts";
export { LspSession } from "./lsp/lsp-session.ts";
export { csharpLsWorkspaceRoot, shutdownCSharpLsSessions, withCSharpLsSession } from "./lsp/providers/csharp-ls-session.ts";

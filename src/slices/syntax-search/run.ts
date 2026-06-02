import type { CodeIntelConfig, CodeIntelSyntaxSearchParams } from "../../types.ts";
import { runTreeSitterSyntaxSearch } from "../../tree-sitter.ts";

export async function runSyntaxSearch(params: CodeIntelSyntaxSearchParams, repoRoot: string, config: CodeIntelConfig, signal?: AbortSignal): Promise<Record<string, unknown>> {
	return runTreeSitterSyntaxSearch(params, repoRoot, config, signal);
}

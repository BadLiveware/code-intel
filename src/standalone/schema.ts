import type { JsonObjectSchema } from "../tool-registry.ts";

export function stringParam(description: string): Record<string, unknown> {
	return { type: "string", description };
}

export function numberParam(description: string): Record<string, unknown> {
	return { type: "number", description };
}

export function booleanParam(description: string): Record<string, unknown> {
	return { type: "boolean", description };
}

export function stringArrayParam(description: string): Record<string, unknown> {
	return { type: "array", items: { type: "string" }, description };
}

export function recordParam(description: string): Record<string, unknown> {
	return { type: "object", additionalProperties: true, description };
}

export function enumParam(values: readonly string[], description: string): Record<string, unknown> {
	return { enum: values, description };
}

export function objectSchema(properties: Record<string, unknown>, required: string[] = []): JsonObjectSchema {
	return { type: "object", properties, required, additionalProperties: false };
}

export const repoRootProperty = stringParam("Repository or directory to inspect. Defaults to the current working directory.");
export const timeoutProperty = numberParam("Command timeout in milliseconds. Defaults to config queryTimeoutMs.");
export const maxResultsProperty = numberParam("Maximum results returned. Defaults to config maxResults.");
export const detailProperty = enumParam(["locations", "snippets"], "Output detail. Use 'locations' when you plan to read/edit returned files; use 'snippets' for small inline context.");
export const sourceDetailProperty = enumParam(["source", "locations"], "Output detail. source returns bounded source segments; locations returns target metadata only.");
export const confirmReferencesProperty = enumParam(["gopls", "typescript", "clangd", "rust-analyzer", "csharp-ls", "pyrefly"], "Optional exact-reference confirmation for matching source-code tests when applicable.");

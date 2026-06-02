import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { codeIntelToolSpec, listCodeIntelToolSpecs } from "../tool-registry.ts";
import type { CodeIntelEnv } from "./env.ts";

function toolAnnotations(mutates: boolean): Record<string, unknown> {
	return {
		readOnlyHint: !mutates,
		destructiveHint: mutates,
		idempotentHint: !mutates,
		openWorldHint: false,
	};
}

export function createCodeIntelMcpServer(env: CodeIntelEnv): Server {
	const includeMutations = env.mutationPolicy === "enabled";
	const server = new Server({ name: "code-intelligence", version: "0.1.0" }, {
		capabilities: { tools: {} },
		instructions: "Use code-intel tools as bounded current-source routing, outline, and symbol-context helpers. Read returned source locations before making claims; use project-native validation for behavior.",
	});

	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: listCodeIntelToolSpecs({ includeMutations }).map((spec) => ({
			name: spec.name,
			title: spec.title,
			description: [spec.description, spec.promptSnippet, ...spec.promptGuidelines].filter(Boolean).join("\n"),
			inputSchema: spec.inputSchema,
			annotations: toolAnnotations(spec.mutates),
		})),
	}));

	server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
		const spec = codeIntelToolSpec(request.params.name, { includeMutations });
		if (!spec) {
			return { content: [{ type: "text" as const, text: `Unknown or unavailable code-intel tool: ${request.params.name}` }], isError: true };
		}
		if (spec.mutates && env.mutationPolicy !== "enabled") {
			return { content: [{ type: "text" as const, text: `Code-intel tool ${spec.name} is disabled because mutations are disabled.` }], isError: true };
		}
		try {
			const result = await spec.run((request.params.arguments ?? {}) as Record<string, unknown>, env, extra.signal);
			return {
				content: [{ type: "text" as const, text: result.contentText }],
				structuredContent: result.details,
			};
		} catch (error) {
			return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true };
		}
	});

	return server;
}

export async function runCodeIntelMcpServer(env: CodeIntelEnv): Promise<void> {
	const server = createCodeIntelMcpServer(env);
	const transport = new StdioServerTransport();
	await server.connect(transport);
}

import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fixtureRepo } from "./test-harness.ts";

async function withCodeIntelMcp<T>(repo: string, run: (client: Client) => Promise<T>): Promise<T> {
	const cliPath = fileURLToPath(new URL("../src/standalone/cli.ts", import.meta.url));
	const client = new Client({ name: "code-intel-standalone-test", version: "0.1.0" }, { capabilities: {} });
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: ["--experimental-strip-types", cliPath, "mcp", "--cwd", repo],
		stderr: "pipe",
	});
	try {
		await client.connect(transport);
		return await run(client);
	} finally {
		await client.close();
	}
}

test("standalone MCP server lists read-only tools and hides mutations", async () => {
	const repo = fixtureRepo();
	await withCodeIntelMcp(repo, async (client) => {
		const listed = await client.listTools();
		const names = listed.tools.map((tool) => tool.name).sort();
		assert.equal(names.length, 10);
		assert.equal(names.includes("code_intel_file_outline"), true);
		assert.equal(names.includes("code_intel_read_symbol"), true);
		assert.equal(names.includes("code_intel_replace_symbol"), false);
		assert.equal(names.includes("code_intel_insert_relative"), false);
		assert.equal(listed.tools.every((tool) => tool.annotations?.readOnlyHint === true), true);
	});
});

test("standalone MCP server returns structured outline and symbol content", async () => {
	const repo = fixtureRepo();
	await withCodeIntelMcp(repo, async (client) => {
		const outline = await client.callTool({
			name: "code_intel_file_outline",
			arguments: { path: "main.ts", maxSymbols: 20 },
		});
		assert.equal(outline.isError, undefined);
		assert.equal((outline.structuredContent as any).file, "main.ts");
		assert.equal(Array.isArray((outline.structuredContent as any).declarations), true);
		assert.equal((outline.structuredContent as any).declarations.some((decl: any) => decl.name === "authenticate"), true);

		const symbol = await client.callTool({
			name: "code_intel_read_symbol",
			arguments: { path: "main.ts", symbol: "authenticate" },
		});
		assert.equal(symbol.isError, undefined);
		assert.equal((symbol.structuredContent as any).ok, true);
		assert.equal((symbol.structuredContent as any).target.name, "authenticate");
		assert.match((symbol.structuredContent as any).targetSegment.source, /export function authenticate/);
	});
});

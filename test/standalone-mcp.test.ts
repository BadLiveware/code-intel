import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fixtureRepo } from "./test-harness.ts";

async function withCodeIntelMcp<T>(repo: string, run: (client: Client) => Promise<T>, extraArgs: string[] = []): Promise<T> {
	const cliPath = fileURLToPath(new URL("../src/standalone/cli.ts", import.meta.url));
	const client = new Client({ name: "code-intel-standalone-test", version: "0.1.0" }, { capabilities: {} });
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: ["--experimental-strip-types", cliPath, "mcp", "--cwd", repo, ...extraArgs],
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

test("standalone MCP server answers in text only and omits structuredContent by default", async () => {
	const repo = fixtureRepo();
	await withCodeIntelMcp(repo, async (client) => {
		const outline = await client.callTool({
			name: "code_intel_file_outline",
			arguments: { path: "main.ts", maxSymbols: 20 },
		});
		assert.equal(outline.isError, undefined);
		assert.equal(outline.structuredContent, undefined);
		const outlineText = (outline.content as any)[0].text as string;
		assert.match(outlineText, /main\.ts/);
		assert.match(outlineText, /authenticate/);

		const symbol = await client.callTool({
			name: "code_intel_read_symbol",
			arguments: { path: "main.ts", symbol: "authenticate" },
		});
		assert.equal(symbol.isError, undefined);
		assert.equal(symbol.structuredContent, undefined);
		const symbolText = (symbol.content as any)[0].text as string;
		assert.match(symbolText, /export function authenticate/);
		// The answer still names the symbol, its range, its ref and its drift hash exactly once.
		assert.equal(symbolText.match(/authenticate/g)!.length >= 2, true);
		assert.equal((symbolText.match(/ref=/g) ?? []).length, 1);
		assert.equal((symbolText.match(/hash=/g) ?? []).length, 1);
		assert.equal(symbolText.includes("context:"), false);
	});
});

test("standalone MCP server ships structuredContent only when asked", async () => {
	const repo = fixtureRepo();
	await withCodeIntelMcp(repo, async (client) => {
		const symbol = await client.callTool({
			name: "code_intel_read_symbol",
			arguments: { path: "main.ts", symbol: "authenticate" },
		});
		assert.equal(symbol.isError, undefined);
		assert.equal((symbol.structuredContent as any).ok, true);
		assert.equal((symbol.structuredContent as any).target.name, "authenticate");
		assert.match((symbol.structuredContent as any).targetSegment.source, /export function authenticate/);
	}, ["--structured-content"]);
});

test("symbol targets carry no field that restates another field in the same response", async () => {
	const repo = fixtureRepo();
	await withCodeIntelMcp(repo, async (client) => {
		const outline = await client.callTool({
			name: "code_intel_file_outline",
			arguments: { path: "main.ts", maxSymbols: 20 },
		});
		const details = outline.structuredContent as any;
		const target = details.declarations.find((decl: any) => decl.name === "authenticate").symbolTarget;
		// Each of these restated a sibling field, a response-level field, or a constant.
		for (const dropped of ["uri", "detail", "positionEncoding", "source", "containerName", "language", "sourceHash"]) {
			assert.equal(target[dropped], undefined, `symbolTarget.${dropped} should not be emitted`);
		}
		// What round-tripping a target actually needs survives.
		assert.equal(target.path, "main.ts");
		assert.equal(typeof target.targetRef, "string");
		assert.equal(typeof target.range.startLine, "number");
		assert.equal(details.declarations.every((decl: any) => decl.readHint === undefined), true);
		assert.equal(typeof details.coverage.sourceHash, "string");
	}, ["--structured-content"]);
});

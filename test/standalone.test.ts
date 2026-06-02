import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { shutdownCSharpLsSessions } from "../src/lsp/providers/csharp-ls-session.ts";
import { collectTouchedDiagnostics } from "../src/slices/post-edit-map/diagnostics.ts";
import { createCodeIntelEnv } from "../src/standalone/env.ts";
import { listCodeIntelToolSpecs, runCodeIntelTool } from "../src/tool-registry.ts";
import { DEFAULT_CONFIG } from "../src/types.ts";
import { fixtureRepo } from "./test-harness.ts";

async function withPath(pathValue: string, run: () => Promise<void>): Promise<void> {
	const originalPath = process.env.PATH;
	process.env.PATH = pathValue;
	try {
		await run();
	} finally {
		process.env.PATH = originalPath;
	}
}

function writeFakeCSharpLs(file: string): void {
	fs.writeFileSync(file, `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  console.log("fake csharp-ls 1.0");
  process.exit(0);
}
let buffer = Buffer.alloc(0);
function write(message) {
  const body = JSON.stringify(message);
  process.stdout.write("Content-Length: " + Buffer.byteLength(body, "utf-8") + "\\r\\n\\r\\n" + body);
}
function parse() {
  while (true) {
    const headerEnd = buffer.indexOf("\\r\\n\\r\\n");
    if (headerEnd < 0) return;
    const header = buffer.subarray(0, headerEnd).toString("utf-8");
    const match = /Content-Length:\\s*(\\d+)/i.exec(header);
    if (!match) { buffer = buffer.subarray(headerEnd + 4); continue; }
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + Number(match[1]);
    if (buffer.length < bodyEnd) return;
    const message = JSON.parse(buffer.subarray(bodyStart, bodyEnd).toString("utf-8"));
    buffer = buffer.subarray(bodyEnd);
    handle(message);
  }
}
function handle(message) {
  if (message.method === "initialize") write({ jsonrpc: "2.0", id: message.id, result: { capabilities: {} } });
  else if (message.method === "textDocument/didOpen") return;
  else if (message.method === "textDocument/references") {
    const uri = message.params?.textDocument?.uri;
    write({ jsonrpc: "2.0", id: message.id, result: [{ uri, range: { start: { line: 10, character: 22 }, end: { line: 10, character: 34 } } }] });
  } else if (message.method === "shutdown") write({ jsonrpc: "2.0", id: message.id, result: null });
  else if (message.method === "exit") process.exit(0);
}
process.stdin.on("data", (chunk) => { buffer = Buffer.concat([buffer, chunk]); parse(); });
`);
	fs.chmodSync(file, 0o755);
}

function writeLoggingCSharpLs(file: string, logFile: string): void {
	fs.writeFileSync(file, `#!/usr/bin/env node
const fs = require("node:fs");
const logFile = ${JSON.stringify(logFile)};
function log(message) { fs.appendFileSync(logFile, message + "\\n"); }
if (process.argv.includes("--version")) {
  console.log("fake csharp-ls 1.0");
  process.exit(0);
}
log("start " + process.pid);
const docs = new Map();
let buffer = Buffer.alloc(0);
function write(message) {
  const body = JSON.stringify(message);
  process.stdout.write("Content-Length: " + Buffer.byteLength(body, "utf-8") + "\\r\\n\\r\\n" + body);
}
function parse() {
  while (true) {
    const headerEnd = buffer.indexOf("\\r\\n\\r\\n");
    if (headerEnd < 0) return;
    const header = buffer.subarray(0, headerEnd).toString("utf-8");
    const match = /Content-Length:\\s*(\\d+)/i.exec(header);
    if (!match) { buffer = buffer.subarray(headerEnd + 4); continue; }
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + Number(match[1]);
    if (buffer.length < bodyEnd) return;
    const message = JSON.parse(buffer.subarray(bodyStart, bodyEnd).toString("utf-8"));
    buffer = buffer.subarray(bodyEnd);
    handle(message);
  }
}
function publishDiagnostics(uri, text) {
  const line = text.includes("FreshDiagnostic") ? 7 : 5;
  write({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, diagnostics: [{ range: { start: { line, character: 2 }, end: { line, character: 7 } }, severity: 1, source: "csharp-ls", code: "FAKE", message: "fake diagnostic" }] } });
}
function handle(message) {
  if (message.method === "initialize") {
    log("initialize");
    write({ jsonrpc: "2.0", id: message.id, result: { capabilities: { textDocumentSync: 1 } } });
  } else if (message.method === "textDocument/didOpen") {
    const doc = message.params?.textDocument;
    docs.set(doc?.uri, doc?.text || "");
    log("didOpen " + doc?.uri);
    publishDiagnostics(doc?.uri, doc?.text || "");
  } else if (message.method === "textDocument/didChange") {
    const uri = message.params?.textDocument?.uri;
    const text = message.params?.contentChanges?.at(-1)?.text || "";
    docs.set(uri, text);
    log("didChange " + uri + " v" + message.params?.textDocument?.version);
    publishDiagnostics(uri, text);
  } else if (message.method === "textDocument/references") {
    const uri = message.params?.textDocument?.uri;
    const text = docs.get(uri) || "";
    const line = text.includes("FreshCall") ? 12 : 10;
    log("references line=" + line);
    write({ jsonrpc: "2.0", id: message.id, result: [{ uri, range: { start: { line, character: 22 }, end: { line, character: 34 } } }] });
  } else if (message.method === "shutdown") {
    log("shutdown");
    write({ jsonrpc: "2.0", id: message.id, result: null });
  } else if (message.method === "exit") process.exit(0);
}
process.stdin.on("data", (chunk) => { buffer = Buffer.concat([buffer, chunk]); parse(); });
`);
	fs.chmodSync(file, 0o755);
}

test("standalone registry exposes read-only tools by default and runs impact map", async () => {
	const repo = fixtureRepo();
	const env = createCodeIntelEnv({ cwd: repo });
	const tools = listCodeIntelToolSpecs();
	assert.equal(tools.some((tool) => tool.name === "code_intel_impact_map"), true);
	assert.equal(tools.some((tool) => tool.mutates), false);

	const result = await runCodeIntelTool("code_intel_impact_map", { changedFiles: ["main.ts"], maxResults: 5 }, env);
	assert.match(result.contentText, /^OK impact_map/);
	assert.equal(result.details.ok, true);
	assert.equal(Array.isArray(result.details.related), true);
});

test("standalone auto path base accepts cwd-relative paths inside a larger git checkout", async () => {
	const repo = fixtureRepo();
	const packageDir = path.join(repo, "packages", "api");
	fs.mkdirSync(packageDir, { recursive: true });
	fs.writeFileSync(path.join(packageDir, "feature.ts"), `export function apiFeature() { return true }\nexport function caller() { return apiFeature() }\n`);
	const env = createCodeIntelEnv({ cwd: packageDir });

	const outline = await runCodeIntelTool("code_intel_file_outline", { path: "feature.ts", maxSymbols: 10 }, env);
	assert.equal(outline.details.file, "packages/api/feature.ts");

	const impact = await runCodeIntelTool("code_intel_impact_map", { changedFiles: ["feature.ts"], maxResults: 5 }, env);
	assert.equal(impact.details.ok, true);
	assert.deepEqual((impact.details.coverage as any).changedFiles, ["packages/api/feature.ts"]);
});

test("broad scans respect gitignore but allow generated-output opt-in", async () => {
	const repo = fixtureRepo();
	fs.writeFileSync(path.join(repo, ".gitignore"), "obj/\nbin/\n");
	fs.mkdirSync(path.join(repo, "obj"), { recursive: true });
	fs.writeFileSync(path.join(repo, "obj", "GeneratedThing.g.ts"), `import { authenticate } from "../main"\n\nexport function generatedThing() {\n  return authenticate("generated")\n}\n`);
	const env = createCodeIntelEnv({ cwd: repo });

	const routeDefault = await runCodeIntelTool("code_intel_repo_route", { terms: ["generatedThing"], maxResults: 20 }, env);
	assert.equal((routeDefault.details.candidates as any[]).some((row) => row.file === "obj/GeneratedThing.g.ts"), false);
	assert.equal((routeDefault.details.coverage as any).gitIgnoreApplied, true);

	const routeIncluded = await runCodeIntelTool("code_intel_repo_route", { terms: ["generatedThing"], includeIgnored: true, maxResults: 20 }, env);
	assert.equal((routeIncluded.details.candidates as any[]).some((row) => row.file === "obj/GeneratedThing.g.ts"), true);

	const routeExplicit = await runCodeIntelTool("code_intel_repo_route", { terms: ["generatedThing"], paths: ["obj"], maxResults: 20 }, env);
	assert.equal((routeExplicit.details.candidates as any[]).some((row) => row.file === "obj/GeneratedThing.g.ts"), true);
	assert.equal((routeExplicit.details.coverage as any).explicitIgnoredPathScanned, true);

	const impactDefault = await runCodeIntelTool("code_intel_impact_map", { changedFiles: ["main.ts"], maxResults: 50 }, env);
	assert.equal((impactDefault.details.related as any[]).some((row) => row.file === "obj/GeneratedThing.g.ts"), false);

	const impactIncluded = await runCodeIntelTool("code_intel_impact_map", { changedFiles: ["main.ts"], includeIgnored: true, maxResults: 50 }, env);
	assert.equal((impactIncluded.details.related as any[]).some((row) => row.file === "obj/GeneratedThing.g.ts"), true);

	const impactExplicit = await runCodeIntelTool("code_intel_impact_map", { changedFiles: ["main.ts"], paths: ["obj"], maxResults: 50 }, env);
	assert.equal((impactExplicit.details.related as any[]).some((row) => row.file === "obj/GeneratedThing.g.ts"), true);
});

test("parsed record cache invalidates when file content changes", async () => {
	const repo = fixtureRepo();
	const env = createCodeIntelEnv({ cwd: repo });

	const first = await runCodeIntelTool("code_intel_file_outline", { path: "main.ts", maxSymbols: 20 }, env);
	assert.equal((first.details.declarations as any[]).some((row) => row.name === "authenticate"), true);

	fs.writeFileSync(path.join(repo, "main.ts"), `export function authorize(token: string): boolean {
  return token === "ok"
}
`);
	const second = await runCodeIntelTool("code_intel_file_outline", { path: "main.ts", maxSymbols: 20 }, env);
	assert.equal((second.details.declarations as any[]).some((row) => row.name === "authenticate"), false);
	assert.equal((second.details.declarations as any[]).some((row) => row.name === "authorize"), true);
});

test("C# exact references are promoted into impact related rows", async () => {
	const repo = fixtureRepo();
	fs.writeFileSync(path.join(repo, "Demo.csproj"), `<Project Sdk="Microsoft.NET.Sdk"></Project>\n`);
	fs.writeFileSync(path.join(repo, "AuthService.cs"), `namespace Demo;

public class AuthService
{
    public bool Authenticate(string token)
    {
        return token.Length > 0;
    }

    public bool Run()
    {
        return Authenticate("x");
    }
}
`);
	const binDir = path.join(repo, "bin");
	fs.mkdirSync(binDir, { recursive: true });
	writeFakeCSharpLs(path.join(binDir, "csharp-ls"));
	await withPath(`${binDir}${path.delimiter}${process.env.PATH ?? ""}`, async () => {
		const env = createCodeIntelEnv({ cwd: repo });
		const impact = await runCodeIntelTool("code_intel_impact_map", { symbols: ["Authenticate"], confirmReferences: "csharp-ls", maxReferenceRoots: 1, maxReferenceResults: 5, maxResults: 20 }, env);
		assert.equal((impact.details.referenceConfirmation as any).backend, "csharp-ls");
		assert.equal((impact.details.coverage as any).exactReferenceLane, "csharp-ls");
		assert.equal((impact.details.related as any[])[0].kind, "exact_reference");
		assert.equal((impact.details.related as any[])[0].evidence, "csharp-ls:textDocument/references");
		assert.equal((impact.details.related as any[])[0].file, "AuthService.cs");
	});
});

test("persistent C# exact references refresh files and restart on project graph changes", async () => {
	const repo = fixtureRepo();
	fs.writeFileSync(path.join(repo, "Demo.csproj"), `<Project Sdk="Microsoft.NET.Sdk"></Project>\n`);
	fs.writeFileSync(path.join(repo, "AuthService.cs"), `namespace Demo;

public class AuthService
{
    public bool Authenticate(string token)
    {
        return token.Length > 0;
    }

    public bool Run()
    {
        return Authenticate("x");
    }
}
`);
	const logFile = path.join(repo, "csharp-ls.log");
	const binDir = path.join(repo, "bin");
	fs.mkdirSync(binDir, { recursive: true });
	writeLoggingCSharpLs(path.join(binDir, "csharp-ls"), logFile);
	try {
		await withPath(`${binDir}${path.delimiter}${process.env.PATH ?? ""}`, async () => {
			const env = createCodeIntelEnv({ cwd: repo, persistentLsp: true });
			const params = { symbols: ["Authenticate"], confirmReferences: "csharp-ls", maxReferenceRoots: 1, maxReferenceResults: 5, maxResults: 20 };
			const first = await runCodeIntelTool("code_intel_impact_map", params, env);
			assert.equal((first.details.referenceConfirmation as any).session.reused, false);
			assert.equal((first.details.related as any[])[0].line, 11);

			fs.writeFileSync(path.join(repo, "AuthService.cs"), `namespace Demo;

public class AuthService
{
    public bool Authenticate(string token)
    {
        return token.Length > 0;
    }

    public bool Run()
    {
        var marker = "FreshCall";
        return Authenticate(marker);
    }
}
`);
			const second = await runCodeIntelTool("code_intel_impact_map", params, env);
			assert.equal((second.details.referenceConfirmation as any).session.reused, true);
			assert.equal((second.details.related as any[])[0].line, 13);

			fs.writeFileSync(path.join(repo, "Demo.csproj"), `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net9.0</TargetFramework></PropertyGroup></Project>\n`);
			const third = await runCodeIntelTool("code_intel_impact_map", params, env);
			assert.equal((third.details.referenceConfirmation as any).session.restarted, true);
			assert.equal((third.details.related as any[])[0].line, 13);
		});
	} finally {
		await shutdownCSharpLsSessions();
	}
	const log = fs.readFileSync(logFile, "utf-8");
	assert.equal((log.match(/^initialize$/gm) ?? []).length, 2);
	assert.equal((log.match(/^didOpen /gm) ?? []).length, 2);
	assert.equal((log.match(/^didChange /gm) ?? []).length, 1);
	assert.equal((log.match(/^shutdown$/gm) ?? []).length, 2);
});

test("persistent C# diagnostics force a same-text refresh", async () => {
	const repo = fixtureRepo();
	fs.writeFileSync(path.join(repo, "Demo.csproj"), `<Project Sdk="Microsoft.NET.Sdk"></Project>\n`);
	fs.writeFileSync(path.join(repo, "AuthService.cs"), `namespace Demo;

public class AuthService
{
    public bool Run()
    {
        return true;
    }
}
`);
	const logFile = path.join(repo, "csharp-ls-diagnostics.log");
	const binDir = path.join(repo, "bin");
	fs.mkdirSync(binDir, { recursive: true });
	writeLoggingCSharpLs(path.join(binDir, "csharp-ls"), logFile);
	try {
		await withPath(`${binDir}${path.delimiter}${process.env.PATH ?? ""}`, async () => {
			const first = await collectTouchedDiagnostics(repo, ["AuthService.cs"], DEFAULT_CONFIG, undefined, { persistentLsp: true });
			assert.equal(first.diagnostics[0]?.line, 6);
			const firstStatus = first.providerStatuses.find((row) => row.provider === "csharp-ls") as any;
			assert.equal(firstStatus.session.reused, false);

			fs.writeFileSync(path.join(repo, "AuthService.cs"), `namespace Demo;

public class AuthService
{
    public bool Run()
    {
        var marker = "FreshDiagnostic";
        return marker.Length > 0;
    }
}
`);
			const second = await collectTouchedDiagnostics(repo, ["AuthService.cs"], DEFAULT_CONFIG, undefined, { persistentLsp: true });
			assert.equal(second.diagnostics[0]?.line, 8);
			const secondStatus = second.providerStatuses.find((row) => row.provider === "csharp-ls") as any;
			assert.equal(secondStatus.session.reused, true);
		});
	} finally {
		await shutdownCSharpLsSessions();
	}
	const log = fs.readFileSync(logFile, "utf-8");
	assert.equal((log.match(/^initialize$/gm) ?? []).length, 1);
	assert.equal((log.match(/^didOpen /gm) ?? []).length, 1);
	assert.equal((log.match(/^didChange /gm) ?? []).length, 1);
	assert.equal((log.match(/^shutdown$/gm) ?? []).length, 1);
});

test("standalone registry gates mutation tools unless enabled", async () => {
	const repo = fixtureRepo();
	const env = createCodeIntelEnv({ cwd: repo });
	assert.equal(listCodeIntelToolSpecs().some((tool) => tool.name === "code_intel_replace_symbol"), false);
	await assert.rejects(
		() => runCodeIntelTool("code_intel_replace_symbol", { path: "main.ts", symbol: "authenticate", oldHash: "bad", newText: "" }, env),
		/Unknown or unavailable code-intel tool/,
	);
});

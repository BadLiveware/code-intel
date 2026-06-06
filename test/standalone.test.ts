import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { compactCodeIntelOutput } from "../src/compact-output.ts";
import { shutdownCSharpLsSessions } from "../src/lsp/providers/csharp-ls-session.ts";
import { collectTouchedDiagnostics } from "../src/slices/post-edit-map/diagnostics.ts";
import { runPostEditMap } from "../src/slices/targeted-symbols/run.ts";
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

test("repo route ranks exact source evidence above broad docs and tests", async () => {
	const repo = fixtureRepo();
	fs.mkdirSync(path.join(repo, "src", "auth"), { recursive: true });
	fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
	fs.mkdirSync(path.join(repo, "tests"), { recursive: true });
	fs.writeFileSync(path.join(repo, "src", "auth", "session.ts"), `export function authenticateUser(token: string) {\n  return token.length > 0\n}\n`);
	fs.writeFileSync(path.join(repo, "docs", "authentication.md"), `# Authentication\n\nUse auth to authenticate users. Auth docs mention auth repeatedly.\n`);
	fs.writeFileSync(path.join(repo, "tests", "auth.test.ts"), `import { authenticateUser } from "../src/auth/session"\n\ntest("auth", () => authenticateUser("token"))\n`);
	fs.writeFileSync(path.join(repo, "notes.txt"), `auth authenticate authentication auth\n`);
	const env = createCodeIntelEnv({ cwd: repo });

	const route = await runCodeIntelTool("code_intel_repo_route", { terms: ["auth", "authenticate"], maxResults: 20, maxMatchesPerFile: 5 }, env);
	const candidates = route.details.candidates as any[];
	const source = candidates.find((row) => row.file === "src/auth/session.ts");
	const doc = candidates.find((row) => row.file === "docs/authentication.md");
	const testFile = candidates.find((row) => row.file === "tests/auth.test.ts");
	assert.ok(source, "source candidate should be returned");
	assert.ok(doc, "doc candidate should be returned");
	assert.ok(testFile, "test candidate should be returned");
	assert.equal(source.evidence.some((row: any) => row.kind === "declaration"), true);
	assert.equal(source.score > doc.score, true);
	assert.equal(source.score > testFile.score, true);

	const firstPage = await runCodeIntelTool("code_intel_repo_route", { terms: ["auth", "authenticate"], maxResults: 5, maxMatchesPerFile: 5 }, env);
	assert.equal((firstPage.details.summary as any).remainingCount, 1);
	assert.equal((firstPage.details.summary as any).nextOffset, 5);
	assert.match(firstPage.contentText, /more: 1 remaining; rerun with offset=5/);
	assert.match(firstPage.contentText, /Only 1 more candidate\(s\) remain; rerun with offset=5/);
	const secondPage = await runCodeIntelTool("code_intel_repo_route", { terms: ["auth", "authenticate"], maxResults: 5, offset: 5, maxMatchesPerFile: 5 }, env);
	assert.equal((secondPage.details.summary as any).offset, 5);
	assert.equal((secondPage.details.summary as any).remainingCount, 0);
	assert.equal((secondPage.details.candidates as any[]).length, 1);
	assert.equal((firstPage.details.candidates as any[]).some((row) => row.file === (secondPage.details.candidates as any[])[0].file), false);
	assert.match(secondPage.contentText, /^OK repo_route .*\nsummary: .* offset=5 /);

	const narrowRoute = await runCodeIntelTool("code_intel_repo_route", { terms: ["auth", "authenticate"], maxResults: 2, maxMatchesPerFile: 5 }, env);
	assert.equal((narrowRoute.details.guidance as string[]).some((line) => /narrow/i.test(line) || /truncated/i.test(line)), true);
	assert.match(narrowRoute.contentText, /narrow: .*paths.*exact API\/symbol terms/);
});

test("repo route demotes generic helper matches when domain evidence is stronger", async () => {
	const repo = fixtureRepo();
	fs.mkdirSync(path.join(repo, "src", "payment"), { recursive: true });
	fs.mkdirSync(path.join(repo, "src", "helpers"), { recursive: true });
	fs.mkdirSync(path.join(repo, "tests"), { recursive: true });
	fs.writeFileSync(path.join(repo, "src", "payment", "payment-loader.ts"), `export function loadPaymentConfig(path: string) {\n  return { path }\n}\n`);
	fs.writeFileSync(path.join(repo, "src", "helpers", "load.ts"), `export function load(value: string) {\n  return value\n}\n`);
	fs.writeFileSync(path.join(repo, "src", "helpers", "run.ts"), `export function run() {\n  return load("x")\n}\n`);
	fs.writeFileSync(path.join(repo, "tests", "payment-load.test.ts"), `import { loadPaymentConfig } from "../src/payment/payment-loader"\nloadPaymentConfig("fixture")\n`);
	const env = createCodeIntelEnv({ cwd: repo });

	const route = await runCodeIntelTool("code_intel_repo_route", { terms: ["load", "payment"], maxResults: 20, maxMatchesPerFile: 5 }, env);
	const candidates = route.details.candidates as any[];
	const domain = candidates.find((row) => row.file === "src/payment/payment-loader.ts");
	const genericHelper = candidates.find((row) => row.file === "src/helpers/load.ts");
	assert.ok(domain, "domain source candidate should be returned");
	assert.ok(genericHelper, "generic helper candidate should be returned");
	assert.equal(domain.score > genericHelper.score, true);
	assert.equal(genericHelper.evidence.some((row: any) => row.term === "load" && row.generic === true), true);
	assert.equal((route.details.guidance as string[]).some((line) => /Generic term\(s\) load/.test(line)), true);
	assert.match(route.contentText, /narrow: .*Generic term\(s\) load/);
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

test("post-edit diagnostics expose provenance, provider, and freshness confidence", async () => {
	const repo = fixtureRepo();
	fs.writeFileSync(path.join(repo, "broken.ts"), `export const value: number = "wrong";\n`);
	const env = createCodeIntelEnv({ cwd: repo });

	const result = await runCodeIntelTool("code_intel_post_edit_map", {
		changedFiles: ["broken.ts"],
		includeDiagnostics: true,
		includeCallers: false,
		includeTests: false,
		diagnostics: [{ path: "broken.ts", line: 1, column: 14, severity: "warning", source: "eslint", provider: "eslint", code: "no-explicit-any", message: "supplied diagnostic" }],
		maxResults: 20,
	}, env);
	assert.equal(result.details.ok, true);
	const rows = result.details.touchedDiagnostics as any[];
	const supplied = rows.find((row) => row.code === "no-explicit-any");
	assert.equal(supplied.provenance, "supplied");
	assert.equal(supplied.source, "eslint");
	assert.equal(supplied.provider, "eslint");
	assert.equal(supplied.freshness, "unknown");
	assert.equal(supplied.baselineStatus, "not-compared");
	const collected = rows.find((row) => row.source === "typescript" && row.code === "TS2322");
	assert.equal(collected.provider, "typescript");
	assert.equal(collected.provenance, "collected");
	assert.equal(collected.freshness, "current-workspace-files");
	assert.equal(collected.baselineStatus, "not-compared");
	assert.equal((result.details.diagnosticProviders as any[]).some((row) => row.provider === "typescript" && row.freshness === "current-workspace-files" && row.baselineStatus === "not-compared"), true);
});

test("post-edit partial phase metadata preserves completed results", async () => {
	const repo = fixtureRepo();
	const result = await runPostEditMap({
		changedFiles: ["main.ts"],
		includeDiagnostics: true,
		diagnostics: [{ path: "main.ts", line: 1, column: 17, severity: "error", source: "typescript", code: "TS_FAKE" }],
		maxResults: 20,
	}, repo, DEFAULT_CONFIG, undefined, { testPhaseFailures: { diagnosticsCollection: "fake diagnostics provider failure" } });
	assert.equal(result.ok, true);
	assert.equal(result.partial, true);
	assert.equal((result.changedSymbols as any[]).length > 0, true);
	assert.equal((result.related as any[]).length > 0, true);
	assert.equal(Array.isArray(result.testCandidates), true);
	assert.equal((result.touchedDiagnostics as any[]).some((row) => row.code === "TS_FAKE" && row.provenance === "supplied"), true);
	const failedPhase = (result.phaseTimings as any[]).find((row) => row.name === "diagnosticsCollection");
	assert.equal(failedPhase.status, "failed");
	assert.equal(failedPhase.diagnostic, "fake diagnostics provider failure");
	assert.equal((result.validationHints as any[]).some((row) => row.kind === "partial" && /completed phase results were preserved/.test(row.message)), true);
	assert.deepEqual((result.coverage as any).failedPhases, ["diagnosticsCollection"]);
	const content = compactCodeIntelOutput("post_edit", result);
	assert.match(content, /phases: diagnosticsCollection failed \d+ms — fake diagnostics provider failure/);
	assert.match(content, /changed main\.ts:/);
});

test("post-edit compact output leads with action summary before changed details", () => {
	const content = compactCodeIntelOutput("post_edit", {
		ok: true,
		elapsedMs: 7,
		changedFiles: ["src/service.ts"],
		changedFileContexts: [{ file: "src/service.ts", kind: "source", language: "typescript", symbolCount: 1, reason: "Changed declarations extracted.", validationHint: "Read the changed declaration targets." }],
		changedSymbols: [{ target: { path: "src/service.ts", name: "lowLevelField", range: { startLine: 42, endLine: 42 } } }],
		related: [{ file: "src/caller.ts", line: 12, kind: "syntax_call", name: "useService" }],
		testCandidates: [{ file: "src/service.test.ts", score: 30 }],
		touchedDiagnostics: [{ path: "src/service.ts", line: 4, severity: "error", code: "TS2322" }],
		diagnosticTargets: [],
		validationHints: [
			{ kind: "diagnostics", message: "Inspect 1 touched diagnostic before rerunning validation." },
			{ kind: "tests", message: "Inspect or run 1 likely test candidate." },
		],
		summary: { changedFileCount: 1, changedSymbolCount: 1, relatedCount: 1, testCandidateCount: 1, diagnosticCount: 1, diagnosticTargetCount: 0 },
		phaseTimings: [{ name: "changedSymbols", status: "passed", elapsedMs: 1, slow: false }],
		limitations: ["Post-edit maps are locator-mode routing evidence and validation hints; they do not run tests or apply fixes."],
	});
	const lines = content.split("\n");
	assert.match(lines[0], /^OK post_edit_map 7ms files=1$/);
	assert.match(lines[1], /^next: .*diagnostic.*test candidate/);
	assert.match(lines[2], /^summary: changed=1 related=1 tests=1 diagnostics=1/);
	const limitationIndex = lines.findIndex((line) => line.startsWith("limitations: "));
	const changedIndex = lines.findIndex((line) => line.startsWith("changed "));
	assert.ok(limitationIndex > 0);
	assert.ok(changedIndex > limitationIndex);
	assert.equal(lines.some((line) => line.startsWith("related src/caller.ts:12")), true);
	assert.equal(lines.some((line) => line.startsWith("test src/service.test.ts")), true);
	assert.equal(lines.some((line) => line.startsWith("phases: ")), false);
});

test("post-edit map preserves C# project-boundary and no-symbol changed files", async () => {
	const repo = fixtureRepo();
	fs.writeFileSync(path.join(repo, "Demo.csproj"), `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net9.0</TargetFramework></PropertyGroup></Project>\n`);
	fs.mkdirSync(path.join(repo, "Properties"), { recursive: true });
	fs.writeFileSync(path.join(repo, "Properties", "AssemblyInfo.cs"), `using System.Reflection;\n[assembly: AssemblyTitle("Demo")]\n`);
	fs.writeFileSync(path.join(repo, "AuthService.cs"), `namespace Demo;\n\npublic class AuthService\n{\n    public bool Authenticate(string token) => token.Length > 0;\n}\n`);
	fs.writeFileSync(path.join(repo, "AuthServiceTests.cs"), `namespace Demo.Tests;\n\npublic class AuthServiceTests\n{\n    public void CallsAuthenticate()\n    {\n        new Demo.AuthService().Authenticate("x");\n    }\n}\n`);
	const env = createCodeIntelEnv({ cwd: repo });

	const result = await runCodeIntelTool("code_intel_post_edit_map", { changedFiles: ["Demo.csproj", "Properties/AssemblyInfo.cs"], maxResults: 20 }, env);
	assert.equal(result.details.ok, true);
	assert.equal((result.details.summary as any).changedFileCount, 2);
	assert.equal((result.details.summary as any).changedSymbolCount, 0);
	assert.equal((result.details.summary as any).projectBoundaryCount, 1);
	assert.equal((result.details.summary as any).nonSymbolChangedFileCount, 2);
	assert.deepEqual((result.details.coverage as any).projectBoundaryFiles, ["Demo.csproj"]);
	assert.deepEqual((result.details.coverage as any).nonSymbolChangedFiles, ["Demo.csproj", "Properties/AssemblyInfo.cs"]);
	const contexts = result.details.changedFileContexts as any[];
	assert.equal(contexts.find((row) => row.file === "Demo.csproj")?.kind, "project-boundary");
	assert.equal(contexts.find((row) => row.file === "Properties/AssemblyInfo.cs")?.kind, "source-no-symbols");
	const hints = result.details.validationHints as any[];
	assert.equal(hints.some((row) => row.kind === "changed-files" && /No changed declarations/.test(row.message)), true);
	assert.equal(hints.some((row) => row.kind === "project-boundary" && row.file === "Demo.csproj"), true);
	assert.equal(hints.some((row) => row.kind === "direct-inspection" && row.file === "Properties/AssemblyInfo.cs"), true);
	assert.match(result.contentText, /^OK post_edit_map .*files=2\nnext: .*No changed declarations.*project-boundary/s);
	assert.match(result.contentText, /summary: changed=0 related=0 tests=0 diagnostics=0 projectBoundary=1 noSymbolFiles=2/);
	assert.match(result.contentText, /changed-file Demo\.csproj project-boundary/);
	assert.match(result.contentText, /changed-file Properties\/AssemblyInfo\.cs source-no-symbols/);
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

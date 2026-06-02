import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { createCodeIntelEnv } from "../src/standalone/env.ts";
import { listCodeIntelToolSpecs, runCodeIntelTool } from "../src/tool-registry.ts";
import { fixtureRepo } from "./test-harness.ts";

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

test("standalone registry gates mutation tools unless enabled", async () => {
	const repo = fixtureRepo();
	const env = createCodeIntelEnv({ cwd: repo });
	assert.equal(listCodeIntelToolSpecs().some((tool) => tool.name === "code_intel_replace_symbol"), false);
	await assert.rejects(
		() => runCodeIntelTool("code_intel_replace_symbol", { path: "main.ts", symbol: "authenticate", oldHash: "bad", newText: "" }, env),
		/Unknown or unavailable code-intel tool/,
	);
});

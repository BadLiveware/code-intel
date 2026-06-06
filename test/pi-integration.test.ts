import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import * as integration from "../src/pi-integration.ts";

const packageRoot = path.resolve(import.meta.dirname, "..");

test("pi integration facade exposes the Pi adapter contract", () => {
	const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf-8")) as { exports?: Record<string, unknown> };
	const exportRow = packageJson.exports?.["./pi-integration"] as { types?: string; import?: string } | undefined;
	assert.equal(exportRow?.types, "./dist/pi-integration.d.ts");
	assert.equal(exportRow?.import, "./dist/pi-integration.js");

	const tsconfig = JSON.parse(fs.readFileSync(path.join(packageRoot, "tsconfig.build.json"), "utf-8")) as { files?: string[] };
	assert.equal(tsconfig.files?.includes("src/pi-integration.ts"), true);

	assert.equal(typeof integration.listCodeIntelToolSpecs, "function");
	assert.equal(typeof integration.codeIntelToolSpec, "function");
	assert.equal(typeof integration.runCodeIntelTool, "function");
	assert.equal(typeof integration.loadStandaloneConfig, "function");
	assert.equal(typeof integration.createCodeIntelEnv, "function");
	assert.equal(typeof integration.ensureInsideRoot, "function");
	assert.equal(typeof integration.resolveRepoRootsFromCwd, "function");
	assert.equal(typeof integration.collectTouchedDiagnostics, "function");
	assert.equal(typeof integration.backendStatuses, "function");
	assert.equal(typeof integration.languageServerStatusesFromProviders, "function");
	assert.equal(typeof integration.stateToolSpec, "object");
	assert.equal(typeof integration.postEditMapToolSpec, "object");
	assert.equal(typeof integration.readSymbolToolSpec, "object");

	const names = integration.listCodeIntelToolSpecs({ includeMutations: true }).map((spec) => spec.name);
	for (const name of ["code_intel_state", "code_intel_file_outline", "code_intel_post_edit_map", "code_intel_replace_symbol"]) {
		assert.equal(names.includes(name), true, `${name} missing from facade registry`);
	}
});

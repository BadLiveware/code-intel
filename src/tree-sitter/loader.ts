import { createRequire } from "node:module";
import * as path from "node:path";
import type { LanguageSpec } from "../languages.ts";
import type { ParserBundle } from "./nodes.ts";

let initPromise: Promise<any> | undefined;
const parserPromises = new Map<string, Promise<ParserBundle>>();

export async function loadTreeSitter(): Promise<{ module: any; wasmDir: string }> {
	if (!initPromise) {
		initPromise = (async () => {
			const require = createRequire(import.meta.url);
			const packageJson = require.resolve("@vscode/tree-sitter-wasm/package.json");
			const wasmDir = path.join(path.dirname(packageJson), "wasm");
			const module = await import("@vscode/tree-sitter-wasm");
			const treeSitter: any = (module as any).default ?? module;
			await treeSitter.Parser.init({ locateFile: (scriptName: string) => path.join(wasmDir, scriptName) });
			return { module: treeSitter, wasmDir };
		})();
	}
	return initPromise;
}

export async function parserFor(spec: LanguageSpec): Promise<ParserBundle> {
	const existing = parserPromises.get(spec.id);
	if (existing) return existing;
	const promise = (async () => {
		const loaded = await loadTreeSitter();
		const language = await loaded.module.Language.load(path.join(loaded.wasmDir, spec.wasm));
		const parser = new loaded.module.Parser();
		parser.setLanguage(language);
		return { parser, language, spec, Query: loaded.module.Query };
	})();
	parserPromises.set(spec.id, promise);
	return promise;
}

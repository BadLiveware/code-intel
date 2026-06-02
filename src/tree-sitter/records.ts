import type { ResultDetail } from "../types.ts";
import { languageCapability } from "../languages.ts";
import type { ParsedFile, SymbolRecord } from "./nodes.ts";
import { extractGenericFileRecords } from "../language-support/extractors/generic.ts";
import { extractRustFileRecords } from "../language-support/extractors/rust.ts";
import { extractTypeScriptFileRecords } from "../language-support/extractors/typescript.ts";
import { extractGoFileRecords } from "../language-support/extractors/go.ts";
import { extractPythonFileRecords } from "../language-support/extractors/python.ts";
import { extractCppFileRecords } from "../language-support/extractors/cpp.ts";
import { extractCSharpFileRecords } from "../language-support/extractors/csharp.ts";
import { extractShellFileRecords } from "../language-support/extractors/shell.ts";
import { extractMarkdownFileRecords } from "../language-support/extractors/markdown.ts";
import type { LanguageExtractor } from "../language-support/types.ts";

const extractors: Record<string, LanguageExtractor> = {
	generic: extractGenericFileRecords,
	rust: extractRustFileRecords,
	typescript: extractTypeScriptFileRecords,
	go: extractGoFileRecords,
	python: extractPythonFileRecords,
	cpp: extractCppFileRecords,
	csharp: extractCSharpFileRecords,
	shell: extractShellFileRecords,
	markdown: extractMarkdownFileRecords,
};

export function extractFileRecords(parsed: ParsedFile, detail: ResultDetail): { definitions: SymbolRecord[]; candidates: SymbolRecord[] } {
	const extractorId = languageCapability(parsed.language)?.extractor ?? "generic";
	const extractor = extractors[extractorId] ?? extractGenericFileRecords;
	return extractor(parsed, detail);
}

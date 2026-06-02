import * as fs from "node:fs";
import * as path from "node:path";
import type { CodeIntelConfig, CodeIntelPostEditMapParams, CodeIntelReadSymbolParams, ResultDetail } from "../../types.ts";
import { LANGUAGE_CAPABILITIES, languageCapability, languageSpec } from "../../languages.ts";
import { changedFilesFromBase, ensureInsideRoot } from "../../repo.ts";
import { runImpactMap } from "../impact-map/run.ts";
import { runTestMap } from "../orientation/run.ts";
import { buildSymbolTarget, exactLineSlice, expandedRange, locatorMetadata, rangeFromRecord, readHintForTarget, rangeLineCount, shortHash, sliceLines, sourceHash, targetFromUnknown, type SourceRange, type SourceSegment, type SymbolRelocationHints, type SymbolTarget } from "../../source-range.ts";
import { extractFileRecords, parseFiles, readSourceFileAsParsed, type ParsedFile, type SymbolRecord } from "../../tree-sitter.ts";
import { isRecord, normalizePositiveInteger, normalizeStringArray, summarizeFileDistribution } from "../../util.ts";
import { collectTouchedDiagnostics, mergeDiagnostics, normalizePostEditDiagnostics } from "../post-edit-map/diagnostics.ts";

const FUNCTION_LIKE_KINDS = /function|method|constructor/i;
const VALUE_KINDS = /constant|variable|var_spec|const_spec/i;
const TYPE_KINDS = /class|struct|enum|interface|type/i;
const KEYWORDS = new Set([
	"as", "async", "await", "break", "case", "catch", "class", "const", "continue", "default", "defer", "do", "else", "enum", "export", "extends", "false", "finally", "for", "from", "func", "function", "go", "if", "import", "in", "interface", "let", "new", "nil", "null", "package", "pub", "return", "select", "static", "struct", "switch", "this", "throw", "true", "try", "type", "undefined", "var", "void", "while",
]);

export type ResolvedSelection = {
	parsed: ParsedFile;
	records: SymbolRecord[];
	record?: SymbolRecord;
	target?: SymbolTarget;
	alternatives?: SymbolTarget[];
	diagnostics: string[];
};

function languageForFile(file: string): string | undefined {
	const ext = path.extname(file);
	return LANGUAGE_CAPABILITIES.find((capability) => capability.extensions.includes(ext))?.id;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function targetInput(params: CodeIntelReadSymbolParams | CodeIntelPostEditMapParams): Partial<SymbolTarget> | undefined {
	return targetFromUnknown((params as CodeIntelReadSymbolParams).target);
}

function requestedPath(params: CodeIntelReadSymbolParams | CodeIntelPostEditMapParams): string | undefined {
	return targetInput(params)?.path || stringValue((params as CodeIntelReadSymbolParams).path);
}

function targetName(params: CodeIntelReadSymbolParams): string | undefined {
	return targetInput(params)?.name || stringValue(params.symbol) || stringValue(params.name);
}

function targetOwner(params: CodeIntelReadSymbolParams): string | undefined {
	const input = targetInput(params);
	return input?.containerName || input?.owner || stringValue(params.owner);
}

function targetKind(params: CodeIntelReadSymbolParams): string | undefined {
	return targetInput(params)?.kind || stringValue(params.kind);
}

function targetSignature(params: CodeIntelReadSymbolParams): string | undefined {
	return targetInput(params)?.signature || stringValue(params.signature);
}

function targetRef(params: CodeIntelReadSymbolParams): string | undefined {
	const input = targetInput(params);
	return input?.targetRef || input?.symbolRef || input?.rangeId || stringValue(params.symbolRef) || stringValue(params.rangeId);
}

function rangeMatches(recordRange: SourceRange, targetRange: SourceRange | undefined): boolean {
	return !!targetRange && recordRange.startLine === targetRange.startLine && recordRange.endLine === targetRange.endLine && recordRange.startColumn === targetRange.startColumn && recordRange.endColumn === targetRange.endColumn;
}

function recordContainsLocation(record: SymbolRecord, line: number, column?: number): boolean {
	if (line < record.line || line > record.endLine) return false;
	if (column === undefined) return true;
	if (line === record.line && column < record.column) return false;
	if (line === record.endLine && record.endColumn > 0 && column > record.endColumn) return false;
	return true;
}

function rangeSize(record: SymbolRecord): number {
	return Math.max(1, record.endLine - record.line + 1);
}

function refParts(ref: string | undefined): string[] {
	if (!ref) return [];
	const parts = [ref];
	const suffix = ref.includes("@") ? ref.split("@").pop() : undefined;
	if (suffix && suffix !== ref) parts.push(suffix);
	return parts;
}

function targetRefs(target: SymbolTarget): string[] {
	return [target.targetRef, target.symbolRef, target.rangeId, ...refParts(target.symbolRef)].filter((value, index, values): value is string => typeof value === "string" && value.length > 0 && values.indexOf(value) === index);
}

function refMatches(ref: string | undefined, target: SymbolTarget): boolean {
	if (!ref) return false;
	const requested = new Set(refParts(ref));
	return targetRefs(target).some((candidate) => requested.has(candidate));
}

function countOverlap(left: string[] | undefined, right: string[] | undefined): number {
	if (!left?.length || !right?.length) return 0;
	const rightSet = new Set(right);
	return left.filter((value) => rightSet.has(value)).length;
}

function relocationScore(requested: SymbolRelocationHints | undefined, current: SymbolRelocationHints | undefined): number {
	if (!requested || !current) return 0;
	const before = countOverlap(requested.before, current.before);
	const after = countOverlap(requested.after, current.after);
	const container = requested.containerRef && current.containerRef && requested.containerRef === current.containerRef ? 4 : 0;
	const ordinal = requested.siblingOrdinal !== undefined && current.siblingOrdinal !== undefined ? Math.max(0, 3 - Math.min(3, Math.abs(requested.siblingOrdinal - current.siblingOrdinal))) : 0;
	return before * 8 + after * 8 + (before > 0 && after > 0 ? 8 : 0) + container + ordinal;
}

async function parseTargetFile(params: CodeIntelReadSymbolParams, repoRoot: string, config: CodeIntelConfig, signal?: AbortSignal): Promise<ResolvedSelection> {
	const diagnostics: string[] = [];
	const rawPath = requestedPath(params);
	if (!rawPath) {
		return { parsed: undefined as never, records: [], alternatives: [], diagnostics: ["A target path or path is required"] };
	}
	let safeFile: string;
	try {
		safeFile = ensureInsideRoot(repoRoot, rawPath);
	} catch (error) {
		return { parsed: undefined as never, records: [], alternatives: [], diagnostics: [error instanceof Error ? error.message : String(error)] };
	}
	const language = targetInput(params)?.language || languageForFile(safeFile);
	const capability = language ? languageCapability(language) : undefined;
	if (!language || !capability || (!languageSpec(language) && capability.parser.kind !== "scanner")) return { parsed: undefined as never, records: [], alternatives: [], diagnostics: [`No Tree-sitter language configured for ${safeFile}`] };
	const timeoutMs = normalizePositiveInteger(params.timeoutMs, config.queryTimeoutMs, 1_000, 600_000);
	const parsed = capability.parser.kind === "scanner" ? { parsedFiles: [readSourceFileAsParsed(repoRoot, safeFile, language)], diagnostics: [], filesByLanguage: { [language]: 1 }, parsedByLanguage: { [language]: 1 } } : await parseFiles(repoRoot, [language], [safeFile], [], [], timeoutMs, signal);
	const parsedFile = parsed.parsedFiles.find((file) => file.file === safeFile);
	if (!parsedFile) return { parsed: undefined as never, records: [], alternatives: [], diagnostics: parsed.diagnostics.length ? parsed.diagnostics : [`${safeFile}: file could not be parsed`] };
	let records: SymbolRecord[] = [];
	try {
		records = extractFileRecords(parsedFile, "locations").definitions;
	} catch (error) {
		diagnostics.push(`${safeFile}: Tree-sitter record extraction failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	return { parsed: parsedFile, records, diagnostics: [...parsed.diagnostics, ...diagnostics] };
}

function selectRecord(params: CodeIntelReadSymbolParams, parsed: ParsedFile, records: SymbolRecord[], repoRoot: string): { record?: SymbolRecord; target?: SymbolTarget; alternatives?: SymbolTarget[] } {
	const targets = new Map<SymbolRecord, SymbolTarget>();
	const targetFor = (record: SymbolRecord) => {
		let target = targets.get(record);
		if (!target) {
			target = buildSymbolTarget(record, parsed.source, repoRoot, records);
			targets.set(record, target);
		}
		return target;
	};
	const requested = targetInput(params);
	const ref = targetRef(params);
	if (requested?.rangeId || ref) {
		const exactRangeRef = requested?.rangeId ?? ref;
		const exact = records.filter((record) => targetFor(record).rangeId === exactRangeRef || refParts(exactRangeRef).includes(targetFor(record).rangeId));
		if (exact.length === 1) return { record: exact[0], target: targetFor(exact[0]) };
	}
	const line = numberValue(params.line);
	if (line !== undefined) {
		const column = numberValue(params.column);
		const matched = records.filter((record) => recordContainsLocation(record, line, column)).sort((left, right) => rangeSize(left) - rangeSize(right));
		if (matched.length > 0) return { record: matched[0], target: targetFor(matched[0]), alternatives: matched.slice(1, 8).map(targetFor) };
	}
	if (requested?.range) {
		const matched = records.filter((record) => rangeMatches(rangeFromRecord(record), requested.range));
		if (matched.length === 1 && !ref && !targetName(params)) return { record: matched[0], target: targetFor(matched[0]) };
		if (matched.length > 1 && !ref) return { alternatives: matched.map(targetFor) };
	}
	const name = targetName(params);
	const owner = targetOwner(params);
	const kind = targetKind(params);
	const signature = targetSignature(params);
	const requestedArity = targetInput(params)?.arity;
	if (!name && !ref && !requested?.range && !requested?.relocation) return { alternatives: records.slice(0, 12).map(targetFor) };
	const scored = records.map((record) => {
		const target = targetFor(record);
		let score = 0;
		if (refMatches(ref, target)) score += target.rangeId === ref || refParts(ref).includes(target.rangeId) ? 120 : 70;
		if (requested?.targetRef && target.targetRef === requested.targetRef) score += 70;
		if (requested?.symbolRef && refMatches(requested.symbolRef, target)) score += 70;
		if (requested?.rangeId && target.rangeId === requested.rangeId) score += 120;
		if (requested?.range && rangeMatches(rangeFromRecord(record), requested.range)) score += 40;
		if (name && record.name === name) score += 30;
		if (owner && (record.owner === owner || target.containerName === owner)) score += 20;
		if (kind && (record.kind === kind || record.kind.includes(kind) || kind.includes(record.kind))) score += 12;
		if (requestedArity !== undefined && target.arity === requestedArity) score += 8;
		if (signature && target.signature === signature) score += 12;
		else if (signature && target.signature?.includes(signature)) score += 6;
		if (requested?.relocation) score += relocationScore(requested.relocation, target.relocation);
		if (requested?.range) score += Math.max(0, 6 - Math.min(6, Math.abs(record.line - requested.range.startLine)));
		return { record, target, score };
	}).filter((item) => item.score > 0).sort((left, right) => right.score - left.score || rangeSize(left.record) - rangeSize(right.record));
	if (scored.length === 0) return { alternatives: [] };
	if (scored.length === 1 || scored[0].score >= scored[1].score + 8) return { record: scored[0].record, target: scored[0].target, alternatives: scored.slice(1, 8).map((item) => item.target) };
	return { alternatives: scored.slice(0, 20).map((item) => item.target) };
}

export async function resolveSymbolSelection(params: CodeIntelReadSymbolParams, repoRoot: string, config: CodeIntelConfig, signal?: AbortSignal): Promise<ResolvedSelection> {
	const parsedSelection = await parseTargetFile(params, repoRoot, config, signal);
	if (!parsedSelection.parsed) return parsedSelection;
	const selected = selectRecord(params, parsedSelection.parsed, parsedSelection.records, repoRoot);
	return { ...parsedSelection, ...selected };
}

function isFunctionLike(record: SymbolRecord): boolean {
	return FUNCTION_LIKE_KINDS.test(record.kind);
}

function segmentForRecord(parsed: ParsedFile, record: SymbolRecord, target: SymbolTarget, options: { kind: "target" | "context"; contextLines: number; maxBytes: number; reason?: string; evidence?: string }): SourceSegment {
	const baseRange = rangeFromRecord(record);
	const useContext = !isFunctionLike(record) && options.contextLines > 0;
	const fullRange = useContext ? expandedRange(baseRange, options.contextLines, parsed.source) : baseRange;
	const fullSource = exactLineSlice(parsed.source, fullRange);
	const oldHash = shortHash(fullSource);
	let source = fullSource;
	let outputRange = fullRange;
	let truncated = false;
	let omittedLineCount: number | undefined;
	if (Buffer.byteLength(source, "utf8") > options.maxBytes) {
		truncated = true;
		const lines = source.split(/\r?\n/);
		const kept: string[] = [];
		let bytes = 0;
		for (const line of lines) {
			const next = Buffer.byteLength(`${line}\n`, "utf8");
			if (kept.length > 0 && bytes + next > options.maxBytes) break;
			kept.push(line);
			bytes += next;
		}
		source = kept.join("\n");
		outputRange = { ...fullRange, endLine: fullRange.startLine + Math.max(0, kept.length - 1) };
		omittedLineCount = Math.max(0, rangeLineCount(fullRange) - kept.length);
	}
	const segmentTarget = { ...target, range: outputRange };
	return { kind: options.kind, source, oldHash, oldTextReady: !truncated, sourceIncluded: true, sourceCompleteness: truncated ? "partial" : "complete-segment", truncated, lineCount: source ? source.split(/\r?\n/).length : 0, byteCount: Buffer.byteLength(source, "utf8"), omittedLineCount, target: segmentTarget, range: outputRange, readHint: readHintForTarget({ ...target, range: fullRange }, truncated ? "complete target range" : "returned source segment"), reason: options.reason, evidence: options.evidence };
}

function identifiersInSource(source: string): Set<string> {
	const identifiers = new Set<string>();
	for (const match of source.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\b/g)) {
		const value = match[0];
		if (!KEYWORDS.has(value) && value.length > 1) identifiers.add(value);
	}
	return identifiers;
}

function referenceKindAllowed(kind: string, include: Set<string>): boolean {
	if ((include.has("referenced-constants") || include.has("referenced-vars")) && VALUE_KINDS.test(kind)) return true;
	if (include.has("referenced-types") && TYPE_KINDS.test(kind)) return true;
	return false;
}

function targetKey(target: SymbolTarget): string {
	return `${target.path}\0${target.range.startLine}\0${target.range.startColumn}\0${target.range.endLine}\0${target.range.endColumn}\0${target.name}`;
}

function contextSegments(parsed: ParsedFile, records: SymbolRecord[], targetRecord: SymbolRecord, target: SymbolTarget, params: CodeIntelReadSymbolParams, maxBytes: number, repoRoot: string): { segments: SourceSegment[]; deferredReferences: Record<string, unknown>[]; omittedContextCount: number } {
	const include = new Set(normalizeStringArray(params.include));
	if (include.size === 0) return { segments: [], deferredReferences: [], omittedContextCount: 0 };
	const targetSource = sliceLines(parsed.source, rangeFromRecord(targetRecord));
	const identifiers = identifiersInSource(targetSource);
	const maxContextSegments = normalizePositiveInteger(params.maxContextSegments, 8, 0, 50);
	const seen = new Set([targetKey(target)]);
	const segments: SourceSegment[] = [];
	const deferredReferences: Record<string, unknown>[] = [];
	let omittedContextCount = 0;
	for (const record of records) {
		if (!identifiers.has(record.name)) continue;
		const candidateTarget = buildSymbolTarget(record, parsed.source, repoRoot, records);
		if (seen.has(targetKey(candidateTarget))) continue;
		const insideTarget = record.line >= targetRecord.line && record.endLine <= targetRecord.endLine;
		if (insideTarget) continue;
		if (isFunctionLike(record)) {
			deferredReferences.push({ name: record.name, kind: record.kind, target: candidateTarget, reason: "function-reference-deferred" });
			continue;
		}
		if (!referenceKindAllowed(record.kind, include)) continue;
		if (segments.length >= maxContextSegments) {
			omittedContextCount++;
			continue;
		}
		seen.add(targetKey(candidateTarget));
		segments.push(segmentForRecord(parsed, record, candidateTarget, { kind: "context", contextLines: normalizePositiveInteger(params.contextLines, 0, 0, 20), maxBytes, reason: "referenced definition", evidence: "identifier-used-in-target" }));
	}
	return { segments, deferredReferences: deferredReferences.slice(0, 20), omittedContextCount };
}

export async function runReadSymbol(params: CodeIntelReadSymbolParams, repoRoot: string, config: CodeIntelConfig, signal?: AbortSignal): Promise<Record<string, unknown>> {
	const started = Date.now();
	const selected = await resolveSymbolSelection(params, repoRoot, config, signal);
	if (!selected.parsed) return { ok: false, repoRoot, diagnostics: selected.diagnostics, reason: selected.diagnostics[0] ?? "Unable to parse target file", elapsedMs: Date.now() - started };
	const { parsed, records, diagnostics } = selected;
	if (!selected.record || !selected.target) {
		return { ok: false, repoRoot, file: parsed.file, language: parsed.language, sourceIncluded: false, sourceCompleteness: "locations-only", nextReadRecommended: false, nextReadReason: "ambiguous-or-missing-target", alternatives: (selected.alternatives ?? []).slice(0, 20).map((target) => ({ target, readHint: readHintForTarget(target, "candidate declaration range") })), summary: { alternativeCount: selected.alternatives?.length ?? 0 }, diagnostics, limitations: ["Symbol reads use current-source Tree-sitter syntax ranges; use language tooling for semantic definition proof when required."], elapsedMs: Date.now() - started };
	}
	const maxBytes = normalizePositiveInteger(params.maxBytes, 30_000, 1_000, config.maxOutputBytes);
	const contextLines = normalizePositiveInteger(params.contextLines, 0, 0, 50);
	const targetSegment = segmentForRecord(parsed, selected.record, selected.target, { kind: "target", contextLines, maxBytes, reason: "selected target" });
	const context = contextSegments(parsed, records, selected.record, selected.target, params, maxBytes, repoRoot);
	const segments = [targetSegment, ...context.segments];
	const anyPartial = segments.some((segment) => segment.sourceCompleteness === "partial");
	return {
		ok: true,
		repoRoot,
		file: parsed.file,
		language: parsed.language,
		sourceIncluded: true,
		sourceCompleteness: anyPartial ? "partial" : "complete-segment",
		nextReadRecommended: anyPartial,
		nextReadReason: anyPartial ? "one-or-more-segments-truncated" : "complete-target-segment-included",
		target: selected.target,
		targetSegment,
		contextSegments: context.segments,
		deferredReferences: context.deferredReferences,
		readHint: targetSegment.readHint,
		summary: { segmentCount: segments.length, contextSegmentCount: context.segments.length, deferredReferenceCount: context.deferredReferences.length, omittedContextCount: context.omittedContextCount, totalLineCount: segments.reduce((sum, segment) => sum + segment.lineCount, 0), totalByteCount: segments.reduce((sum, segment) => sum + segment.byteCount, 0) },
		coverage: { truncated: anyPartial, maxBytes, sourceHash: sourceHash(parsed.source) },
		diagnostics,
		limitations: ["Symbol reads use current-source Tree-sitter syntax ranges; referenced context is lexical and same-file only.", "Called functions/helpers are reported as deferred references and are not recursively expanded."],
		elapsedMs: Date.now() - started,
	};
}

async function symbolsForFile(repoRoot: string, file: string, config: CodeIntelConfig, signal?: AbortSignal): Promise<{ file: string; language?: string; rows: Array<Record<string, unknown>>; records: SymbolRecord[]; diagnostics: string[]; parsed?: ParsedFile }> {
	const language = languageForFile(file);
	const capability = language ? languageCapability(language) : undefined;
	if (!language || !capability || (!languageSpec(language) && capability.parser.kind !== "scanner")) return { file, language, rows: [], records: [], diagnostics: [`No Tree-sitter language configured for ${file}`] };
	const parsed = capability.parser.kind === "scanner" ? { parsedFiles: [readSourceFileAsParsed(repoRoot, file, language)], diagnostics: [], filesByLanguage: { [language]: 1 }, parsedByLanguage: { [language]: 1 } } : await parseFiles(repoRoot, [language], [file], [], [], config.queryTimeoutMs, signal);
	const parsedFile = parsed.parsedFiles.find((item) => item.file === file);
	if (!parsedFile) return { file, language, rows: [], records: [], diagnostics: parsed.diagnostics };
	try {
		const records = extractFileRecords(parsedFile, "locations").definitions;
		return { file, language, records, rows: records.map((record) => {
			const target = buildSymbolTarget(record, parsedFile.source, repoRoot, records);
			return { target, readHint: readHintForTarget(target, "changed declaration range"), sourceIncluded: false, sourceCompleteness: "locations-only", nextReadRecommended: true, nextReadReason: "source-not-included" };
		}), diagnostics: parsed.diagnostics, parsed: parsedFile };
	} catch (error) {
		return { file, language, rows: [], records: [], diagnostics: [`${file}: Tree-sitter record extraction failed: ${error instanceof Error ? error.message : String(error)}`], parsed: parsedFile };
	}
}

function enclosingTargetForDiagnostic(diag: Record<string, unknown>, parsed: ParsedFile, records: SymbolRecord[], repoRoot: string): Record<string, unknown> | undefined {
	const line = numberValue(diag.line);
	if (line === undefined) return undefined;
	const column = numberValue(diag.column);
	const record = records.filter((candidate) => recordContainsLocation(candidate, line, column)).sort((left, right) => rangeSize(left) - rangeSize(right))[0];
	if (!record) return undefined;
	const target = buildSymbolTarget(record, parsed.source, repoRoot, records);
	return { diagnostic: diag, target, readHint: readHintForTarget(target, "diagnostic enclosing declaration"), sourceIncluded: false, sourceCompleteness: "locations-only", nextReadRecommended: true, nextReadReason: "diagnostic-location" };
}

export async function runPostEditMap(params: CodeIntelPostEditMapParams, repoRoot: string, config: CodeIntelConfig, signal?: AbortSignal): Promise<Record<string, unknown>> {
	const started = Date.now();
	const diagnostics: string[] = [];
	const requested = normalizeStringArray(params.changedFiles);
	const fromBase = await changedFilesFromBase(repoRoot, params.baseRef, config.queryTimeoutMs, config.maxOutputBytes);
	if (fromBase.diagnostic) diagnostics.push(fromBase.diagnostic);
	const changedFiles = [...new Set([...requested, ...fromBase.files].map((file) => {
		try {
			return ensureInsideRoot(repoRoot, file);
		} catch (error) {
			diagnostics.push(error instanceof Error ? error.message : String(error));
			return undefined;
		}
	}).filter((file): file is string => !!file && fs.existsSync(path.join(repoRoot, file))))];
	const changedSymbols: Array<Record<string, unknown>> = [];
	const parsedByFile = new Map<string, Awaited<ReturnType<typeof symbolsForFile>>>();
	if (params.includeChangedSymbols !== false) {
		for (const file of changedFiles.slice(0, 50)) {
			const result = await symbolsForFile(repoRoot, file, config, signal);
			parsedByFile.set(file, result);
			changedSymbols.push(...result.rows);
			diagnostics.push(...result.diagnostics);
		}
	}
	const impact = params.includeCallers === false ? undefined : await runImpactMap({ changedFiles, detail: "locations", maxResults: params.maxResults, timeoutMs: params.timeoutMs }, repoRoot, config, signal);
	const testCandidates: Record<string, unknown>[] = [];
	if (params.includeTests !== false) {
		for (const file of changedFiles.slice(0, 8)) {
			const symbolResult = parsedByFile.get(file) ?? await symbolsForFile(repoRoot, file, config, signal);
			const names = symbolResult.records.map((record) => record.name).slice(0, 12);
			const testMap = await runTestMap({ path: file, symbols: names, maxResults: Math.min(params.maxResults ?? config.maxResults, 10), timeoutMs: params.timeoutMs, detail: "locations" }, repoRoot, config, signal);
			for (const row of Array.isArray(testMap.candidates) ? testMap.candidates.filter(isRecord) : []) testCandidates.push(row);
			diagnostics.push(...(Array.isArray(testMap.diagnostics) ? testMap.diagnostics.map(String) : []));
		}
	}
	const suppliedDiagnostics = normalizePostEditDiagnostics(params.diagnostics);
	const collectedDiagnostics = params.includeDiagnostics === true ? await collectTouchedDiagnostics(repoRoot, changedFiles, config, signal) : { diagnostics: [], providerStatuses: [], toolDiagnostics: [], limitations: [] };
	diagnostics.push(...collectedDiagnostics.toolDiagnostics);
	const diagRows = mergeDiagnostics(suppliedDiagnostics, collectedDiagnostics.diagnostics);
	const diagnosticTargets: Record<string, unknown>[] = [];
	if (params.includeDiagnostics === true || diagRows.length > 0) {
		for (const diag of diagRows.slice(0, params.maxResults ?? config.maxResults)) {
			const file = stringValue(diag.path);
			if (!file) continue;
			let safeFile: string;
			try {
				safeFile = ensureInsideRoot(repoRoot, file);
			} catch (error) {
				diagnostics.push(error instanceof Error ? error.message : String(error));
				continue;
			}
			const symbolResult = parsedByFile.get(safeFile) ?? await symbolsForFile(repoRoot, safeFile, config, signal);
			if (symbolResult.parsed) {
				const target = enclosingTargetForDiagnostic(diag as Record<string, unknown>, symbolResult.parsed, symbolResult.records, repoRoot);
				if (target) diagnosticTargets.push(target);
			}
		}
	}
	const uniqueTestCandidates = [...new Map(testCandidates.map((row) => [String(row.file ?? ""), row])).values()].slice(0, params.maxResults ?? config.maxResults);
	const relatedRows = isRecord(impact) && Array.isArray(impact.related) ? impact.related : [];
	return {
		ok: true,
		repoRoot,
		changedFiles,
		sourceIncluded: false,
		sourceCompleteness: "locations-only",
		nextReadRecommended: true,
		nextReadReason: "post-edit-validation-context",
		changedSymbols,
		related: relatedRows,
		testCandidates: uniqueTestCandidates,
		touchedDiagnostics: diagRows,
		diagnosticTargets,
		diagnosticProviders: collectedDiagnostics.providerStatuses,
		summary: { changedFileCount: changedFiles.length, changedSymbolCount: changedSymbols.length, relatedCount: relatedRows.length, testCandidateCount: uniqueTestCandidates.length, diagnosticCount: diagRows.length, diagnosticTargetCount: diagnosticTargets.length, ...summarizeFileDistribution(changedSymbols.map((row) => isRecord(row.target) ? { file: row.target.path } : row)) },
		coverage: { truncated: changedFiles.length > 50 || changedSymbols.length > (params.maxResults ?? config.maxResults), diagnosticsAvailable: diagRows.length > 0, diagnosticsCollected: params.includeDiagnostics === true, unsupportedFiles: changedFiles.filter((file) => !languageForFile(file)) },
		diagnostics,
		limitations: ["Post-edit maps are locator-mode routing evidence and validation hints; they do not run tests or apply fixes.", "Collected diagnostics are current touched-file diagnostics, not baseline-compared proof that the issue is new.", ...collectedDiagnostics.limitations],
		elapsedMs: Date.now() - started,
	};
}

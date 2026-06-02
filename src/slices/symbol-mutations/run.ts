import * as fs from "node:fs";
import * as path from "node:path";
import type { CodeIntelConfig, CodeIntelInsertRelativeParams, CodeIntelReadSymbolParams, CodeIntelReplaceSymbolParams } from "../../types.ts";
import { ensureInsideRoot } from "../../repo.ts";
import { exactLineSpan, normalizeInsertedText, rangeFromRecord, readHintForTarget, shortHash, sourceHash, type SymbolTarget } from "../../source-range.ts";
import { resolveSymbolSelection } from "../targeted-symbols/run.ts";

function readParams(params: CodeIntelReplaceSymbolParams | CodeIntelInsertRelativeParams): CodeIntelReadSymbolParams {
	const anchor = "anchor" in params ? params.anchor ?? params.target : params.target;
	return {
		repoRoot: params.repoRoot,
		target: anchor,
		path: params.path,
		symbol: params.symbol,
		name: params.name,
		owner: params.owner,
		kind: params.kind,
		signature: params.signature,
		symbolRef: params.symbolRef,
		rangeId: params.rangeId,
		timeoutMs: params.timeoutMs,
	};
}

function failure(started: number, repoRoot: string, reason: string, diagnostics: string[] = []): Record<string, unknown> {
	return { ok: false, repoRoot, changed: false, reason, diagnostics: diagnostics.length ? diagnostics : [reason], elapsedMs: Date.now() - started };
}

async function resolveForMutation(params: CodeIntelReadSymbolParams, repoRoot: string, config: CodeIntelConfig, signal?: AbortSignal) {
	const selected = await resolveSymbolSelection(params, repoRoot, config, signal);
	if (!selected.parsed) return { selected, error: selected.diagnostics[0] ?? "Unable to parse target file" };
	if (!selected.record || !selected.target) return { selected, error: "ambiguous-or-missing-target" };
	return { selected };
}

function targetFile(repoRoot: string, target: SymbolTarget): string {
	return path.join(repoRoot, ensureInsideRoot(repoRoot, target.path));
}

function withNormalizedEol(text: string, eol: "\r\n" | "\n", normalize: boolean | undefined): string {
	return normalize === false ? text : normalizeInsertedText(text, eol);
}

function lineBreakEnds(text: string): boolean {
	return text.endsWith("\n") || text.endsWith("\r");
}

function insertionText(source: string, boundary: number, rawText: string, eol: "\r\n" | "\n", normalize: boolean | undefined): string {
	let text = withNormalizedEol(rawText, eol, normalize);
	const prefix = source.slice(0, boundary);
	const suffix = source.slice(boundary);
	if (prefix && !lineBreakEnds(prefix) && !/^\r?\n/.test(text)) text = `${eol}${text}`;
	if (suffix && text && !lineBreakEnds(text)) text = `${text}${eol}`;
	return text;
}

export async function runReplaceSymbol(params: CodeIntelReplaceSymbolParams, repoRoot: string, config: CodeIntelConfig, signal?: AbortSignal): Promise<Record<string, unknown>> {
	const started = Date.now();
	if (typeof params.newText !== "string") return failure(started, repoRoot, "newText is required");
	if (params.oldText === undefined && !params.oldHash) return failure(started, repoRoot, "oldText or oldHash is required for safe replacement");
	const resolved = await resolveForMutation(readParams(params), repoRoot, config, signal);
	if (resolved.error || !resolved.selected.parsed || !resolved.selected.record || !resolved.selected.target) return failure(started, repoRoot, resolved.error ?? "ambiguous-or-missing-target", resolved.selected.diagnostics);
	const { parsed, record, target, diagnostics } = resolved.selected;
	const span = exactLineSpan(parsed.source, rangeFromRecord(record));
	const oldHash = shortHash(span.text);
	if (params.oldHash && params.oldHash !== oldHash) return failure(started, repoRoot, "oldHash mismatch", [`Expected ${params.oldHash}, found ${oldHash}`]);
	if (params.oldText !== undefined && params.oldText !== span.text) return failure(started, repoRoot, "oldText mismatch", ["Provided oldText does not exactly match the resolved current symbol text"]);
	const newText = withNormalizedEol(params.newText, span.eol, params.normalizeEol);
	const nextSource = `${parsed.source.slice(0, span.startIndex)}${newText}${parsed.source.slice(span.endIndex)}`;
	fs.writeFileSync(targetFile(repoRoot, target), nextSource, "utf-8");
	return {
		ok: true,
		repoRoot,
		file: target.path,
		operation: "replace",
		changed: nextSource !== parsed.source,
		sourceIncluded: false,
		sourceCompleteness: "locations-only",
		nextReadRecommended: true,
		nextReadReason: "symbol-mutated-read-if-source-needed",
		target,
		readHint: readHintForTarget(target, "replaced symbol range before mutation"),
		oldHash,
		newSourceHash: sourceHash(nextSource),
		summary: { byteDelta: Buffer.byteLength(newText, "utf8") - Buffer.byteLength(span.text, "utf8"), oldByteCount: Buffer.byteLength(span.text, "utf8"), newByteCount: Buffer.byteLength(newText, "utf8") },
		diagnostics,
		elapsedMs: Date.now() - started,
	};
}

export async function runInsertRelative(params: CodeIntelInsertRelativeParams, repoRoot: string, config: CodeIntelConfig, signal?: AbortSignal): Promise<Record<string, unknown>> {
	const started = Date.now();
	if (typeof params.text !== "string") return failure(started, repoRoot, "text is required");
	if (params.position !== "before" && params.position !== "after") return failure(started, repoRoot, "position must be before or after");
	const resolved = await resolveForMutation(readParams(params), repoRoot, config, signal);
	if (resolved.error || !resolved.selected.parsed || !resolved.selected.record || !resolved.selected.target) return failure(started, repoRoot, resolved.error ?? "ambiguous-or-missing-target", resolved.selected.diagnostics);
	const { parsed, record, target, diagnostics } = resolved.selected;
	const span = exactLineSpan(parsed.source, rangeFromRecord(record));
	const anchorHash = shortHash(span.text);
	if (params.anchorHash && params.anchorHash !== anchorHash) return failure(started, repoRoot, "anchorHash mismatch", [`Expected ${params.anchorHash}, found ${anchorHash}`]);
	const boundary = params.position === "before" ? span.startIndex : span.afterLineIndex;
	const text = insertionText(parsed.source, boundary, params.text, span.eol, params.normalizeEol);
	const nextSource = `${parsed.source.slice(0, boundary)}${text}${parsed.source.slice(boundary)}`;
	fs.writeFileSync(targetFile(repoRoot, target), nextSource, "utf-8");
	return {
		ok: true,
		repoRoot,
		file: target.path,
		operation: `insert-${params.position}`,
		changed: nextSource !== parsed.source,
		sourceIncluded: false,
		sourceCompleteness: "locations-only",
		nextReadRecommended: true,
		nextReadReason: "relative-insert-read-if-source-needed",
		anchor: target,
		readHint: readHintForTarget(target, "insert anchor range before mutation"),
		anchorHash,
		newSourceHash: sourceHash(nextSource),
		summary: { byteDelta: Buffer.byteLength(text, "utf8"), insertedByteCount: Buffer.byteLength(text, "utf8"), position: params.position },
		diagnostics,
		elapsedMs: Date.now() - started,
	};
}

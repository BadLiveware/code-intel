import * as crypto from "node:crypto";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { SymbolRecord } from "./tree-sitter.ts";
import { isRecord } from "./util.ts";

export type SourceCompleteness = "none" | "locations-only" | "complete-segment" | "partial";

export interface SourceRange {
	startLine: number;
	startColumn: number;
	endLine: number;
	endColumn: number;
}

export interface SymbolRelocationHints {
	version: 1;
	before: string[];
	after: string[];
	siblingOrdinal?: number;
	siblingCount?: number;
	containerRef?: string;
}

export interface SymbolTarget {
	path: string;
	language?: string;
	kind?: string;
	name: string;
	uri?: string;
	source: "tree-sitter" | "lsp" | "mixed";
	positionEncoding: "utf-16";
	owner?: string;
	containerName?: string;
	type?: string;
	detail?: string;
	signature?: string;
	arity?: number;
	exported?: boolean;
	lspKind?: string;
	range: SourceRange;
	selectionRange: SourceRange;
	targetRef: string;
	symbolRef: string;
	rangeId: string;
	relocation?: SymbolRelocationHints;
	sourceHash?: string;
	rangeHash?: string;
}

export interface ReadHint {
	path: string;
	offset: number;
	limit: number;
	reason: string;
	range: SourceRange;
	symbolTarget?: SymbolTarget;
}

export interface SourceSegment {
	kind: "target" | "context";
	source: string;
	oldHash?: string;
	oldTextReady?: boolean;
	sourceIncluded: true;
	sourceCompleteness: "complete-segment" | "partial";
	truncated: boolean;
	lineCount: number;
	byteCount: number;
	omittedLineCount?: number;
	target: SymbolTarget;
	range: SourceRange;
	readHint: ReadHint;
	reason?: string;
	evidence?: string;
}

export interface LocatorMetadata {
	sourceIncluded: false;
	sourceCompleteness: "none" | "locations-only";
	nextReadRecommended: boolean;
	nextReadReason: string;
}

export function shortHash(value: string): string {
	return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function sourceHash(source: string): string {
	return shortHash(source);
}

export function normalizeRange(input: SourceRange): SourceRange {
	const startLine = Math.max(1, Math.round(input.startLine));
	const endLine = Math.max(startLine, Math.round(input.endLine));
	const startColumn = Math.max(0, Math.round(input.startColumn));
	const endColumn = Math.max(0, Math.round(input.endColumn));
	return { startLine, startColumn, endLine, endColumn };
}

export function rangeFromRecord(record: Pick<SymbolRecord, "line" | "column" | "endLine" | "endColumn">): SourceRange {
	return normalizeRange({ startLine: record.line, startColumn: record.column, endLine: record.endLine, endColumn: record.endColumn });
}

export function rangeLineCount(range: SourceRange): number {
	return Math.max(1, range.endLine - range.startLine + 1);
}

export function sliceLines(source: string, range: SourceRange): string {
	const normalized = normalizeRange(range);
	const lines = source.split(/\r?\n/);
	return lines.slice(normalized.startLine - 1, normalized.endLine).join("\n");
}

export function detectEol(source: string): "\r\n" | "\n" {
	return source.includes("\r\n") ? "\r\n" : "\n";
}

function lineStartOffsets(source: string): number[] {
	const starts = [0];
	for (let index = 0; index < source.length; index++) {
		if (source[index] === "\n") starts.push(index + 1);
	}
	return starts;
}

function lineContentEnd(source: string, starts: number[], lineIndex: number): number {
	const nextStart = starts[lineIndex + 1];
	if (nextStart === undefined) return source.length;
	return source[nextStart - 2] === "\r" ? nextStart - 2 : nextStart - 1;
}

export function exactLineSpan(source: string, range: SourceRange): { startIndex: number; endIndex: number; afterLineIndex: number; text: string; eol: "\r\n" | "\n" } {
	const normalized = normalizeRange(range);
	const starts = lineStartOffsets(source);
	const startIndex = starts[Math.min(normalized.startLine - 1, starts.length - 1)] ?? 0;
	const endLineIndex = Math.min(normalized.endLine - 1, starts.length - 1);
	const endIndex = lineContentEnd(source, starts, endLineIndex);
	const afterLineIndex = starts[endLineIndex + 1] ?? endIndex;
	return { startIndex, endIndex, afterLineIndex, text: source.slice(startIndex, endIndex), eol: detectEol(source) };
}

export function exactLineSlice(source: string, range: SourceRange): string {
	return exactLineSpan(source, range).text;
}

export function normalizeInsertedText(text: string, eol: "\r\n" | "\n"): string {
	return eol === "\n" ? text.replace(/\r\n/g, "\n") : text.replace(/\r?\n/g, "\r\n");
}

export function expandedRange(range: SourceRange, contextLines: number, source: string): SourceRange {
	const lineCount = source.split(/\r?\n/).length;
	const context = Math.max(0, Math.round(contextLines));
	return {
		startLine: Math.max(1, range.startLine - context),
		startColumn: context > 0 ? 0 : range.startColumn,
		endLine: Math.min(lineCount, range.endLine + context),
		endColumn: range.endColumn,
	};
}

function compactText(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

export function signatureFromSource(source: string, range: SourceRange, name: string): string | undefined {
	const text = sliceLines(source, range).trim();
	if (!text) return undefined;
	let header = text;
	const bodyIndex = header.indexOf("{");
	if (bodyIndex >= 0) header = header.slice(0, bodyIndex);
	const arrowIndex = header.indexOf("=>");
	if (arrowIndex >= 0) header = header.slice(0, arrowIndex);
	header = compactText(header.replace(/[;{]+$/, ""));
	if (!header || !header.includes(name)) return undefined;
	return header.length > 240 ? `${header.slice(0, 239)}…` : header;
}

export function arityFromSignature(signature: string | undefined): number | undefined {
	if (!signature) return undefined;
	const start = signature.indexOf("(");
	if (start < 0) return undefined;
	let depth = 0;
	let current = "";
	const args: string[] = [];
	for (let index = start + 1; index < signature.length; index++) {
		const char = signature[index];
		if (char === "(" || char === "[" || char === "{" || char === "<") depth++;
		else if (char === ")" && depth === 0) {
			if (current.trim()) args.push(current.trim());
			return args.length;
		} else if ((char === ")" || char === "]" || char === "}" || char === ">") && depth > 0) depth--;
		else if (char === "," && depth === 0) {
			args.push(current.trim());
			current = "";
			continue;
		}
		current += char;
	}
	return undefined;
}

function safeRefPart(value: string | undefined): string {
	return (value ?? "").replace(/[^A-Za-z0-9_.:$-]+/g, "_").slice(0, 80);
}

function stableIdentity(record: SymbolRecord, signature: string | undefined, arity: number | undefined): string {
	return [record.file, record.language ?? "", record.kind, record.owner ?? "", record.name, arity ?? arityFromSignature(signature) ?? ""].join("\0");
}

function stableIdForRecord(record: SymbolRecord, source?: string): string {
	const range = rangeFromRecord(record);
	const signature = record.signature ?? signatureFromSource(source ?? record.text ?? "", source ? range : { startLine: 1, startColumn: 0, endLine: 1, endColumn: 0 }, record.name);
	const arity = record.arity ?? arityFromSignature(signature);
	return shortHash(stableIdentity(record, signature, arity));
}

function sameRecord(left: SymbolRecord, right: SymbolRecord): boolean {
	return left === right || (left.file === right.file && left.kind === right.kind && left.name === right.name && (left.owner ?? "") === (right.owner ?? "") && left.line === right.line && left.column === right.column && left.endLine === right.endLine && left.endColumn === right.endColumn);
}

function anchorHash(targetStableId: string, side: "before" | "after", siblingStableId: string): string {
	return shortHash([targetStableId, side, siblingStableId].join("\0"));
}

function relocationHints(record: SymbolRecord, targetStableId: string, source: string | undefined, peers: SymbolRecord[] | undefined): SymbolRelocationHints | undefined {
	if (!peers || peers.length === 0) return undefined;
	const siblings = peers
		.filter((peer) => peer.file === record.file && (peer.owner ?? "") === (record.owner ?? ""))
		.sort((left, right) => left.line - right.line || left.column - right.column || left.endLine - right.endLine || left.endColumn - right.endColumn || left.name.localeCompare(right.name));
	const index = siblings.findIndex((peer) => sameRecord(peer, record));
	if (index < 0) return undefined;
	const before = siblings.slice(Math.max(0, index - 3), index).reverse().map((peer) => anchorHash(targetStableId, "before", stableIdForRecord(peer, source)));
	const after = siblings.slice(index + 1, index + 4).map((peer) => anchorHash(targetStableId, "after", stableIdForRecord(peer, source)));
	const owner = record.owner || undefined;
	return {
		version: 1,
		before,
		after,
		siblingOrdinal: index,
		siblingCount: siblings.length,
		containerRef: owner ? shortHash([record.file, record.language ?? "", "container", owner].join("\0")) : undefined,
	};
}

function lspKind(kind: string): string | undefined {
	if (/function|method/i.test(kind)) return /method/i.test(kind) ? "method" : "function";
	if (/class/i.test(kind)) return "class";
	if (/struct/i.test(kind)) return "struct";
	if (/enum/i.test(kind)) return "enum";
	if (/interface/i.test(kind)) return "interface";
	if (/type/i.test(kind)) return "typeParameter";
	if (/constant/i.test(kind)) return "constant";
	if (/variable/i.test(kind)) return "variable";
	if (/field|property/i.test(kind)) return /property/i.test(kind) ? "property" : "field";
	return undefined;
}

function selectionRangeFromSource(source: string | undefined, range: SourceRange, name: string): SourceRange {
	if (!source) return range;
	const lines = sliceLines(source, range).split(/\r?\n/);
	for (let index = 0; index < lines.length; index++) {
		const column = lines[index].indexOf(name);
		if (column >= 0) {
			const line = range.startLine + index;
			return { startLine: line, startColumn: column, endLine: line, endColumn: column + name.length };
		}
	}
	return range;
}

export function buildSymbolTarget(record: SymbolRecord, source?: string, repoRoot?: string, peers?: SymbolRecord[]): SymbolTarget {
	const range = rangeFromRecord(record);
	const rangeText = source ? exactLineSlice(source, range) : undefined;
	const rangeHash = rangeText !== undefined ? shortHash(rangeText) : undefined;
	const sourceDigest = source !== undefined ? sourceHash(source) : undefined;
	const signature = record.signature ?? signatureFromSource(source ?? record.text ?? "", source ? range : { startLine: 1, startColumn: 0, endLine: 1, endColumn: 0 }, record.name);
	const arity = record.arity ?? arityFromSignature(signature);
	const owner = record.owner || undefined;
	const stableId = shortHash(stableIdentity(record, signature, arity));
	const rangeIdentity = [record.file, record.language, record.kind, owner ?? "", record.name, signature ?? "", range.startLine, range.startColumn, range.endLine, range.endColumn, rangeHash ?? ""].join("\0");
	const rangeId = shortHash(rangeIdentity);
	const selectionRange = selectionRangeFromSource(source, range, record.name);
	const uri = repoRoot ? pathToFileURL(path.join(repoRoot, record.file)).href : undefined;
	return {
		path: record.file,
		uri,
		language: record.language,
		source: "tree-sitter",
		positionEncoding: "utf-16",
		kind: record.kind,
		lspKind: lspKind(record.kind),
		name: record.name,
		owner,
		containerName: owner,
		type: record.type || undefined,
		detail: signature,
		signature,
		arity,
		exported: record.exported,
		range,
		selectionRange,
		targetRef: stableId,
		symbolRef: `${record.file}#${safeRefPart(record.kind)}#${safeRefPart(owner ? `${owner}.${record.name}` : record.name)}@${stableId}`,
		rangeId,
		relocation: relocationHints(record, stableId, source, peers),
		sourceHash: sourceDigest,
		rangeHash,
	};
}

export function readHintForTarget(target: SymbolTarget, reason = "target declaration range"): ReadHint {
	return { path: target.path, offset: target.range.startLine, limit: rangeLineCount(target.range), reason, range: target.range, symbolTarget: target };
}

export function locatorMetadata(nextReadReason = "source-not-included"): LocatorMetadata {
	return { sourceIncluded: false, sourceCompleteness: "locations-only", nextReadRecommended: true, nextReadReason };
}

export function rowWithTarget(record: SymbolRecord, source?: string, repoRoot?: string, peers?: SymbolRecord[]): Record<string, unknown> {
	const target = buildSymbolTarget(record, source, repoRoot, peers);
	const row: Record<string, unknown> = { kind: record.kind, name: record.name, line: record.line, column: record.column, endLine: record.endLine, endColumn: record.endColumn, symbolTarget: target, readHint: readHintForTarget(target), sourceIncluded: false, sourceCompleteness: "locations-only", nextReadRecommended: true, nextReadReason: "source-not-included" };
	if (record.owner) {
		row.owner = record.owner;
		row.containerName = record.owner;
	}
	if (record.exported !== undefined) row.exported = record.exported;
	if (record.type) row.type = record.type;
	if (target.detail) row.detail = target.detail;
	if (target.signature) row.signature = target.signature;
	if (target.arity !== undefined) row.arity = target.arity;
	if (record.text) row.text = record.text;
	return row;
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function targetFromUnknown(value: unknown): Partial<SymbolTarget> | undefined {
	if (!isRecord(value)) return undefined;
	const pathValue = typeof value.path === "string" ? value.path : undefined;
	const name = typeof value.name === "string" ? value.name : typeof value.symbol === "string" ? value.symbol : undefined;
	const relocation = isRecord(value.relocation) ? {
		version: 1 as const,
		before: stringArray(value.relocation.before),
		after: stringArray(value.relocation.after),
		siblingOrdinal: typeof value.relocation.siblingOrdinal === "number" ? value.relocation.siblingOrdinal : undefined,
		siblingCount: typeof value.relocation.siblingCount === "number" ? value.relocation.siblingCount : undefined,
		containerRef: typeof value.relocation.containerRef === "string" ? value.relocation.containerRef : undefined,
	} : undefined;
	const range = isRecord(value.range) ? normalizeRange({
		startLine: typeof value.range.startLine === "number" ? value.range.startLine : typeof value.range.line === "number" ? value.range.line : typeof value.line === "number" ? value.line : 1,
		startColumn: typeof value.range.startColumn === "number" ? value.range.startColumn : typeof value.range.column === "number" ? value.range.column : typeof value.column === "number" ? value.column : 0,
		endLine: typeof value.range.endLine === "number" ? value.range.endLine : typeof value.endLine === "number" ? value.endLine : typeof value.line === "number" ? value.line : 1,
		endColumn: typeof value.range.endColumn === "number" ? value.range.endColumn : typeof value.endColumn === "number" ? value.endColumn : 0,
	}) : undefined;
	return {
		path: pathValue ?? "",
		language: typeof value.language === "string" ? value.language : undefined,
		kind: typeof value.kind === "string" ? value.kind : undefined,
		name: name ?? "",
		owner: typeof value.owner === "string" ? value.owner : undefined,
		type: typeof value.type === "string" ? value.type : undefined,
		uri: typeof value.uri === "string" ? value.uri : undefined,
		source: value.source === "tree-sitter" || value.source === "lsp" || value.source === "mixed" ? value.source : undefined,
		positionEncoding: value.positionEncoding === "utf-16" ? value.positionEncoding : undefined,
		containerName: typeof value.containerName === "string" ? value.containerName : undefined,
		detail: typeof value.detail === "string" ? value.detail : undefined,
		signature: typeof value.signature === "string" ? value.signature : typeof value.detail === "string" ? value.detail : undefined,
		arity: typeof value.arity === "number" ? value.arity : undefined,
		range,
		selectionRange: isRecord(value.selectionRange) ? normalizeRange({
			startLine: typeof value.selectionRange.startLine === "number" ? value.selectionRange.startLine : 1,
			startColumn: typeof value.selectionRange.startColumn === "number" ? value.selectionRange.startColumn : 0,
			endLine: typeof value.selectionRange.endLine === "number" ? value.selectionRange.endLine : typeof value.selectionRange.startLine === "number" ? value.selectionRange.startLine : 1,
			endColumn: typeof value.selectionRange.endColumn === "number" ? value.selectionRange.endColumn : 0,
		}) : undefined,
		targetRef: typeof value.targetRef === "string" ? value.targetRef : undefined,
		symbolRef: typeof value.symbolRef === "string" ? value.symbolRef : typeof value.targetRef === "string" ? value.targetRef : typeof value.rangeId === "string" ? value.rangeId : undefined,
		rangeId: typeof value.rangeId === "string" ? value.rangeId : undefined,
		relocation,
		sourceHash: typeof value.sourceHash === "string" ? value.sourceHash : undefined,
		rangeHash: typeof value.rangeHash === "string" ? value.rangeHash : undefined,
	};
}

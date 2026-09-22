import { asRecord, compactKind, compactRange, header, num, rows, shortRef, str } from "../../core/compact.ts";

export function compactReadSymbol(payload: Record<string, unknown>): string {
	const summary = asRecord(payload.summary);
	const target = asRecord(payload.target);
	const file = String(payload.file ?? "?");
	const contextCount = num(summary.contextSegmentCount) ?? 0;
	const deferredCount = num(summary.deferredReferenceCount) ?? 0;
	const lines = [`${header("read_symbol", payload)} ${String(payload.language ?? "?")} ${file}`];
	if (contextCount > 0 || deferredCount > 0) lines.push(`context: ${contextCount} segment(s), deferred=${deferredCount}`);
	const segments = [asRecord(payload.targetSegment), ...rows(payload.contextSegments)].filter((row) => Object.keys(row).length > 0).slice(0, 12);
	for (const segment of segments) {
		// The target segment has no target of its own; it is the payload target at segment.range.
		const segmentTarget = Object.keys(asRecord(segment.target)).length > 0 ? asRecord(segment.target) : target;
		const owner = segmentTarget.containerName ?? segmentTarget.owner;
		const name = `${owner ? `${String(owner)}::` : ""}${String(segmentTarget.name ?? "?")}`;
		const range = compactRange(asRecord(segment.range)) ?? compactRange(asRecord(segmentTarget.range)) ?? "?";
		const ref = shortRef(segmentTarget);
		const hash = str(segment.oldHash);
		const path = String(segmentTarget.path ?? file);
		const completeness = segment.truncated ? "partial" : String(payload.sourceCompleteness ?? "complete-segment");
		const where = path === file ? "" : `${path}:`;
		lines.push("", `--- ${compactKind(segmentTarget.kind, owner)} ${name} ${where}${range}${ref ? ` ref=${ref}` : ""}${hash ? ` hash=${hash}` : ""} ${completeness} ---`);
		lines.push(String(segment.source ?? ""));
	}
	return lines.join("\n");
}

import { asRecord, compactKind, compactRange, header, rows, shortRef, str } from "../../core/compact.ts";

export function compactReadSymbol(payload: Record<string, unknown>): string {
	const summary = asRecord(payload.summary);
	const target = asRecord(payload.target);
	const ref = shortRef(target);
	const owner = target.containerName ?? target.owner;
	const targetName = `${owner ? `${String(owner)}::` : ""}${String(target.name ?? "?")}`;
	const lines = [
		`${header("read_symbol", payload)} ${String(payload.language ?? "?")} ${String(payload.file ?? "?")}`,
		`target: ${compactKind(target.kind, target.containerName ?? target.owner)} ${targetName}${compactRange(asRecord(target.range)) ? `:${compactRange(asRecord(target.range))}` : ""}${ref ? ` ref=${ref}` : ""} ${String(payload.sourceCompleteness ?? "?")}`,
		`context: ${summary.contextSegmentCount ?? 0} segment(s), deferred=${summary.deferredReferenceCount ?? 0}`,
	];
	for (const segment of [asRecord(payload.targetSegment), ...rows(payload.contextSegments)].filter((row) => Object.keys(row).length > 0).slice(0, 12)) {
		const segmentTarget = asRecord(segment.target);
		const range = asRecord(segment.range);
		const segmentRef = shortRef(segmentTarget);
		const hash = str(segment.oldHash);
		const label = String(segment.kind ?? "segment");
		const completeness = segment.truncated ? " partial" : "";
		lines.push("", `--- ${label} ${String(segmentTarget.path ?? payload.file ?? "")}:${compactRange(range) ?? "?"}${segmentRef ? ` ref=${segmentRef}` : ""}${hash ? ` hash=${hash}` : ""}${completeness} ---`);
		lines.push(String(segment.source ?? ""));
	}
	return lines.join("\n");
}

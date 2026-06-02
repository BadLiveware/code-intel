import { asRecord, compactRange, header, shortRef, str } from "../../core/compact.ts";

export function compactMutation(payload: Record<string, unknown>, label: string): string {
	const target = asRecord(payload.target ?? payload.anchor);
	const range = asRecord(target.range);
	const name = str(target.name) ?? "?";
	const ref = shortRef(target);
	const summary = asRecord(payload.summary);
	return [
		`${header(label, payload)} ${String(payload.file ?? target.path ?? "?")}`,
		`${String(payload.operation ?? label)} ${name}${compactRange(range) ? `:${compactRange(range)}` : ""}${ref ? ` ref=${ref}` : ""} hash=${String(payload.oldHash ?? payload.anchorHash ?? "?")}`,
		`summary: bytes=${String(summary.byteDelta ?? "?")} changed=${payload.changed === true}`,
	].join("\n");
}

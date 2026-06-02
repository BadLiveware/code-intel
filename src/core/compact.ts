export function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function rows(value: unknown): Record<string, unknown>[] {
	return Array.isArray(value) ? value.filter(isRecord) : [];
}

export function asRecord(value: unknown): Record<string, unknown> {
	return isRecord(value) ? value : {};
}

export function str(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function num(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function loc(row: Record<string, unknown>): string {
	const line = num(row.line);
	const endLine = num(row.endLine);
	if (!line) return "";
	return endLine && endLine !== line ? `:${line}-${endLine}` : `:${line}`;
}

export function compactRange(range: Record<string, unknown>): string | undefined {
	const start = num(range.startLine);
	const end = num(range.endLine);
	if (!start) return undefined;
	return end && end !== start ? `${start}-${end}` : `${start}`;
}

export function shortRef(target: Record<string, unknown>): string | undefined {
	const ref = str(target.targetRef) ?? str(target.rangeId) ?? str(target.symbolRef);
	if (!ref) return undefined;
	return ref.includes("@") ? ref.split("@").pop() : ref;
}

export function readHintText(row: Record<string, unknown>): string | undefined {
	const hint = asRecord(row.readHint);
	const offset = num(hint.offset);
	const limit = num(hint.limit);
	return offset && limit ? `${offset}+${limit}` : undefined;
}

export function compactKind(kind: unknown, owner?: unknown): string {
	const text = String(kind ?? "item");
	if (owner) {
		if (text.includes("field")) return "field";
		return "method";
	}
	if (text.includes("class")) return "class";
	if (text.includes("struct")) return "struct";
	if (text.includes("enum")) return "enum";
	if (text.includes("interface")) return "iface";
	if (text.includes("type")) return "type";
	if (text.includes("field")) return "field";
	if (text.includes("constant")) return "const";
	if (text.includes("variable")) return "var";
	if (text.includes("function") || text.includes("method")) return "fn";
	return text.replace(/_declaration|_definition|_specifier/g, "") || "item";
}

export function declarationLine(row: Record<string, unknown>): string {
	const target = asRecord(row.symbolTarget);
	const owner = str(row.containerName) ?? str(row.owner) ?? str(target.containerName) ?? str(target.owner);
	const name = str(row.name) ?? str(target.name) ?? "(anonymous)";
	const qname = owner ? `${owner}::${name}` : name;
	const targetRange = asRecord(target.range);
	const range = compactRange(targetRange) ?? loc(row).replace(/^:/, "");
	const ref = shortRef(target);
	const read = readHintText(row);
	const meta = [ref ? `ref=${ref}` : undefined, read ? `read=${read}` : undefined].filter(Boolean).join(" ");
	return `  ${compactKind(row.kind, owner)} ${qname}${range ? `:${range}` : ""}${meta ? ` ${meta}` : ""}`;
}

export function header(tool: string, payload: Record<string, unknown>): string {
	const ok = payload.ok === false ? "FAIL" : "OK";
	const elapsed = num(payload.elapsedMs);
	return `${ok} ${tool}${elapsed !== undefined ? ` ${elapsed}ms` : ""}`;
}

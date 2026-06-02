export function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function normalizePositiveInteger(value: unknown, fallback: number, min = 1, max = Number.MAX_SAFE_INTEGER): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, Math.round(value)));
}

export function normalizeStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
}

export function summarizeFileDistribution(rows: Array<Record<string, unknown>>, maxTopFiles = 8): Record<string, unknown> {
	const counts = new Map<string, number>();
	for (const row of rows) {
		const file = typeof row.file === "string" && row.file.trim() ? row.file : "(unknown)";
		counts.set(file, (counts.get(file) ?? 0) + 1);
	}
	const topFiles = [...counts.entries()]
		.sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
		.slice(0, maxTopFiles)
		.map(([file, count]) => ({ file, count }));
	return {
		fileCount: counts.size,
		topFiles,
	};
}

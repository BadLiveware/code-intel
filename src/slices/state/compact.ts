import { header, isRecord } from "../../core/compact.ts";

function statusList(value: unknown): string {
	const entries = isRecord(value) ? value : {};
	return Object.entries(entries).map(([key, status]) => `${key}:${String(isRecord(status) ? status.available ?? "?" : "?")}`).join(" ");
}

export function compactState(payload: Record<string, unknown>): string {
	const providers = payload.semanticProviders ?? payload.languageServers;
	const languages = isRecord(payload.languages) ? Object.keys(payload.languages).length : 0;
	return [
		header("state", payload),
		`repo: ${String(payload.repoRoot ?? "?")}`,
		`backends: ${statusList(payload.backends)}`,
		`semanticProviders: ${statusList(providers)}`,
		`languages: ${languages}`,
	].join("\n");
}

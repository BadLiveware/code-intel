import { header, isRecord } from "../../core/compact.ts";

export function compactState(payload: Record<string, unknown>): string {
	const backends = isRecord(payload.backends) ? payload.backends : {};
	const lsps = isRecord(payload.languageServers) ? payload.languageServers : {};
	const backendText = Object.entries(backends).map(([key, value]) => `${key}:${String(isRecord(value) ? value.available ?? "?" : "?")}`).join(" ");
	const lspText = Object.entries(lsps).map(([key, value]) => `${key}:${String(isRecord(value) ? value.available ?? "?" : "?")}`).join(" ");
	const providers = isRecord(payload.semanticProviders) ? payload.semanticProviders : {};
	const providerText = Object.entries(providers).map(([key, value]) => `${key}:${String(isRecord(value) ? value.available ?? "?" : "?")}`).slice(0, 8).join(" ");
	const languages = isRecord(payload.languages) ? Object.keys(payload.languages).length : 0;
	return [header("state", payload), `repo: ${String(payload.repoRoot ?? "?")}`, `backends: ${backendText}`, `languageServers: ${lspText}`, `semanticProviders: ${providerText}`, `languages: ${languages}`].join("\n");
}

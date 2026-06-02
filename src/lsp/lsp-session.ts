import * as fs from "node:fs";
import { pathToFileURL } from "node:url";
import { JsonRpcClient, type JsonRpcClientOptions, type JsonRpcMessage } from "./json-rpc-client.ts";
import { repoFileToUri } from "./uri.ts";

export interface LspSessionOptions extends JsonRpcClientOptions {
	repoRoot: string;
	rootUri?: string;
	capabilities?: Record<string, unknown>;
	initializationOptions?: unknown;
}

export interface OpenedTextDocument {
	uri: string;
	file: string;
	text: string;
	languageId: string;
	version: number;
}

export interface LspLocation {
	uri: string;
	range?: {
		start?: { line?: number; character?: number };
		end?: { line?: number; character?: number };
	};
}

export interface PublishDiagnosticsParams {
	uri?: string;
	diagnostics?: unknown[];
}

export class LspSession {
	readonly client: JsonRpcClient;
	private readonly options: LspSessionOptions;

	constructor(options: LspSessionOptions) {
		this.options = options;
		this.client = new JsonRpcClient(options);
	}

	get diagnostics(): string[] {
		return this.client.diagnostics;
	}

	get stderr(): string {
		return this.client.stderrText();
	}

	async initialize(extraParams: Record<string, unknown> = {}): Promise<JsonRpcMessage> {
		const response = await this.client.request("initialize", {
			processId: process.pid,
			rootUri: this.options.rootUri ?? pathToFileURL(this.options.repoRoot).href,
			capabilities: this.options.capabilities ?? {},
			initializationOptions: this.options.initializationOptions,
			...extraParams,
		});
		this.client.notify("initialized", {});
		return response;
	}

	didOpen(file: string, languageId: string, text?: string): OpenedTextDocument {
		const target = repoFileToUri(this.options.repoRoot, file);
		const documentText = text ?? fs.readFileSync(target.absolutePath, "utf-8");
		const document = { uri: target.uri, file: target.file, text: documentText, languageId, version: 1 };
		this.client.notify("textDocument/didOpen", { textDocument: document });
		return document;
	}

	didChange(document: OpenedTextDocument, text: string, version: number): OpenedTextDocument {
		const updated = { ...document, text, version };
		this.client.notify("textDocument/didChange", {
			textDocument: { uri: updated.uri, version: updated.version },
			contentChanges: [{ text }],
		});
		return updated;
	}

	async references(document: Pick<OpenedTextDocument, "uri">, line: number, character: number, includeDeclaration: boolean, timeoutMs?: number): Promise<JsonRpcMessage> {
		return await this.client.request("textDocument/references", {
			textDocument: { uri: document.uri },
			position: { line, character },
			context: { includeDeclaration },
		}, timeoutMs);
	}

	clearNotifications(method?: string, predicate?: (message: JsonRpcMessage) => boolean): void {
		this.client.clearNotifications(method, predicate);
	}

	async waitForDiagnostics(uri: string, timeoutMs: number): Promise<PublishDiagnosticsParams | undefined> {
		const message = await this.client.waitForNotification("textDocument/publishDiagnostics", (row) => {
			const params = row.params as PublishDiagnosticsParams | undefined;
			return params?.uri === uri;
		}, timeoutMs);
		return message?.params as PublishDiagnosticsParams | undefined;
	}

	async shutdown(): Promise<void> {
		try {
			await this.client.request("shutdown", {}, Math.min(this.options.timeoutMs, 5_000));
		} catch {
			// Shutdown is best-effort; dispose below handles unresponsive servers.
		}
		this.client.notify("exit", {});
		await this.client.dispose();
	}
}

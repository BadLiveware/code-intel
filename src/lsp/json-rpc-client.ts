import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface JsonRpcMessage {
	jsonrpc?: string;
	id?: number | string | null;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: { code?: number; message?: string; data?: unknown };
}

export interface JsonRpcClientOptions {
	command: string;
	args?: string[];
	cwd: string;
	timeoutMs: number;
	signal?: AbortSignal;
	name?: string;
	maxStderrBytes?: number;
}

interface PendingRequest {
	method: string;
	timer: NodeJS.Timeout;
	resolve(message: JsonRpcMessage): void;
	reject(error: Error): void;
}

type NotificationHandler = (message: JsonRpcMessage) => void;

function framedPayload(payload: unknown): string {
	const body = JSON.stringify(payload);
	return `Content-Length: ${Buffer.byteLength(body, "utf-8")}\r\n\r\n${body}`;
}

function rejectAll(pending: Map<number | string, PendingRequest>, error: Error): void {
	for (const [id, request] of pending) {
		clearTimeout(request.timer);
		pending.delete(id);
		request.reject(error);
	}
}

export function parseJsonRpcMessages(buffer: Buffer, onMessage: (message: JsonRpcMessage) => void, diagnostics: string[] = []): Buffer {
	let remaining = buffer;
	while (true) {
		const headerEnd = remaining.indexOf("\r\n\r\n");
		if (headerEnd < 0) return remaining;
		const header = remaining.subarray(0, headerEnd).toString("utf-8");
		const length = /Content-Length:\s*(\d+)/i.exec(header)?.[1];
		if (!length) {
			diagnostics.push("JSON-RPC message missing Content-Length header");
			return remaining.subarray(headerEnd + 4);
		}
		const bodyLength = Number(length);
		const bodyStart = headerEnd + 4;
		const bodyEnd = bodyStart + bodyLength;
		if (remaining.length < bodyEnd) return remaining;
		try {
			onMessage(JSON.parse(remaining.subarray(bodyStart, bodyEnd).toString("utf-8")) as JsonRpcMessage);
		} catch (error) {
			diagnostics.push(`Malformed JSON-RPC message: ${error instanceof Error ? error.message : String(error)}`);
		}
		remaining = remaining.subarray(bodyEnd);
	}
}

export class JsonRpcClient {
	readonly diagnostics: string[] = [];
	private readonly child: ChildProcessWithoutNullStreams;
	private readonly pending = new Map<number | string, PendingRequest>();
	private readonly notifications: JsonRpcMessage[] = [];
	private readonly notificationHandlers = new Set<NotificationHandler>();
	private readonly stderrChunks: Buffer[] = [];
	private stdoutBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
	private nextId = 1;
	private closed = false;
	private readonly abortHandler: () => void;
	private readonly options: JsonRpcClientOptions;

	constructor(options: JsonRpcClientOptions) {
		this.options = options;
		this.child = spawn(options.command, options.args ?? [], { cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"] });
		this.abortHandler = () => {
			this.diagnostics.push(`${this.label()} aborted`);
			rejectAll(this.pending, new Error(`${this.label()} aborted`));
			this.kill();
		};
		options.signal?.addEventListener("abort", this.abortHandler, { once: true });
		this.child.stdout.on("data", (chunk: Buffer) => {
			this.stdoutBuffer = parseJsonRpcMessages(Buffer.concat([this.stdoutBuffer, chunk]), (message) => this.handleMessage(message), this.diagnostics);
		});
		this.child.stderr.on("data", (chunk: Buffer) => {
			const maxBytes = options.maxStderrBytes ?? 200_000;
			const current = this.stderrChunks.reduce((sum, item) => sum + item.length, 0);
			if (current < maxBytes) this.stderrChunks.push(chunk.subarray(0, Math.max(0, maxBytes - current)));
		});
		this.child.stdin.on("error", (error) => this.diagnostics.push(`${this.label()} stdin: ${error.message}`));
		this.child.on("error", (error) => {
			this.diagnostics.push(`${this.label()}: ${error.message}`);
			rejectAll(this.pending, error);
		});
		this.child.on("close", (code, signal) => {
			this.closed = true;
			options.signal?.removeEventListener("abort", this.abortHandler);
			if (this.pending.size > 0) rejectAll(this.pending, new Error(`${this.label()} exited before responding${code === null ? "" : ` with code ${code}`}${signal ? ` signal ${signal}` : ""}`));
		});
	}

	request(method: string, params: unknown, timeoutMs = this.options.timeoutMs): Promise<JsonRpcMessage> {
		if (this.closed) return Promise.reject(new Error(`${this.label()} is not running`));
		const id = this.nextId++;
		const payload = framedPayload({ jsonrpc: "2.0", id, method, params });
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				const error = new Error(`${this.label()} ${method} timed out`);
				reject(error);
				this.kill();
			}, timeoutMs);
			this.pending.set(id, { method, timer, resolve, reject });
			try {
				this.child.stdin.write(payload);
			} catch (error) {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	notify(method: string, params: unknown): void {
		if (this.closed) return;
		try {
			this.child.stdin.write(framedPayload({ jsonrpc: "2.0", method, params }));
		} catch (error) {
			this.diagnostics.push(`${method}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	onNotification(handler: NotificationHandler): () => void {
		this.notificationHandlers.add(handler);
		return () => this.notificationHandlers.delete(handler);
	}

	clearNotifications(method?: string, predicate: (message: JsonRpcMessage) => boolean = () => true): void {
		for (let index = this.notifications.length - 1; index >= 0; index -= 1) {
			const message = this.notifications[index];
			if ((method === undefined || message.method === method) && predicate(message)) this.notifications.splice(index, 1);
		}
	}

	waitForNotification(method: string, predicate: (message: JsonRpcMessage) => boolean = () => true, timeoutMs = this.options.timeoutMs): Promise<JsonRpcMessage | undefined> {
		const existing = this.notifications.find((message) => message.method === method && predicate(message));
		if (existing) return Promise.resolve(existing);
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				unsubscribe();
				resolve(undefined);
			}, timeoutMs);
			const unsubscribe = this.onNotification((message) => {
				if (message.method !== method || !predicate(message)) return;
				clearTimeout(timer);
				unsubscribe();
				resolve(message);
			});
		});
	}

	stderrText(): string {
		return Buffer.concat(this.stderrChunks).toString("utf-8");
	}

	kill(): void {
		try {
			this.child.kill("SIGTERM");
		} catch {
			// Ignore shutdown races.
		}
	}

	async dispose(): Promise<void> {
		this.options.signal?.removeEventListener("abort", this.abortHandler);
		if (this.closed) return;
		await new Promise<void>((resolve) => {
			const termTimer = setTimeout(() => this.kill(), 100);
			const killTimer = setTimeout(() => {
				try {
					this.child.kill("SIGKILL");
				} catch {
					// Ignore shutdown races.
				}
			}, 1_000);
			const doneTimer = setTimeout(resolve, 2_000);
			termTimer.unref?.();
			killTimer.unref?.();
			doneTimer.unref?.();
			this.child.once("close", () => {
				clearTimeout(termTimer);
				clearTimeout(killTimer);
				clearTimeout(doneTimer);
				resolve();
			});
			try {
				this.child.stdin.end();
			} catch {
				// Ignore already-closed stdin.
			}
		});
	}

	private handleMessage(message: JsonRpcMessage): void {
		if (typeof message.id === "number" || typeof message.id === "string") {
			const request = this.pending.get(message.id);
			if (request) {
				clearTimeout(request.timer);
				this.pending.delete(message.id);
				request.resolve(message);
			}
			return;
		}
		if (message.method) {
			this.notifications.push(message);
			for (const handler of this.notificationHandlers) handler(message);
		}
	}

	private label(): string {
		return this.options.name ?? this.options.command;
	}
}

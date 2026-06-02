import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_MAX_OUTPUT_BYTES, DEFAULT_TIMEOUT_MS, type CommandOptions, type CommandResult } from "./types.ts";

export function findExecutable(command: string): string | undefined {
	const pathEnv = process.env.PATH ?? "";
	const extensions = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";") : [""];
	for (const dir of pathEnv.split(path.delimiter)) {
		if (!dir) continue;
		for (const extension of extensions) {
			const candidate = path.join(dir, process.platform === "win32" && extension && !command.toUpperCase().endsWith(extension) ? `${command}${extension}` : command);
			try {
				fs.accessSync(candidate, fs.constants.X_OK);
				const stat = fs.statSync(candidate);
				if (stat.isFile() || stat.isSymbolicLink()) return candidate;
			} catch {
				// Continue scanning PATH.
			}
		}
	}
	return undefined;
}

function appendChunk(chunks: Buffer[], chunk: Buffer, state: { bytes: number; truncated: boolean }, maxBytes: number): void {
	if (state.bytes >= maxBytes) {
		state.truncated = true;
		return;
	}
	const remaining = maxBytes - state.bytes;
	if (chunk.length <= remaining) {
		chunks.push(chunk);
		state.bytes += chunk.length;
		return;
	}
	chunks.push(chunk.subarray(0, remaining));
	state.bytes += remaining;
	state.truncated = true;
}

export async function runCommand(command: string, args: string[], options: CommandOptions): Promise<CommandResult> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
	return await new Promise<CommandResult>((resolve) => {
		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		const outputState = { bytes: 0, truncated: false };
		let settled = false;
		let timedOut = false;
		let child: ReturnType<typeof spawn> | undefined;
		const finish = (result: Omit<CommandResult, "command" | "args" | "cwd" | "stdout" | "stderr" | "timedOut" | "outputTruncated">) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", abortHandler);
			resolve({
				command,
				args,
				cwd: options.cwd,
				exitCode: result.exitCode,
				signal: result.signal,
				stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
				stderr: Buffer.concat(stderrChunks).toString("utf-8"),
				timedOut,
				outputTruncated: outputState.truncated,
				error: result.error,
			});
		};
		const killChild = () => {
			try {
				child?.kill("SIGTERM");
			} catch {
				// Ignore kill errors; close/error handlers finish the result.
			}
		};
		const timer = setTimeout(() => {
			timedOut = true;
			killChild();
		}, timeoutMs);
		const abortHandler = () => {
			timedOut = true;
			killChild();
		};
		options.signal?.addEventListener("abort", abortHandler);
		try {
			child = spawn(command, args, {
				cwd: options.cwd,
				env: { ...process.env, ...options.env },
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (error) {
			finish({ exitCode: null, signal: null, error: error instanceof Error ? error.message : String(error) });
			return;
		}
		child.stdout?.on("data", (chunk: Buffer) => {
			appendChunk(stdoutChunks, chunk, outputState, maxOutputBytes);
			if (outputState.truncated) killChild();
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			appendChunk(stderrChunks, chunk, outputState, maxOutputBytes);
			if (outputState.truncated) killChild();
		});
		child.on("error", (error: NodeJS.ErrnoException) => {
			finish({ exitCode: null, signal: null, error: error.code ?? error.message });
		});
		child.on("close", (exitCode: number | null, signal: NodeJS.Signals | null) => {
			finish({ exitCode, signal });
		});
	});
}

export function parseJson<T>(text: string): T | undefined {
	try {
		return JSON.parse(text) as T;
	} catch {
		return undefined;
	}
}

export function firstLine(text: string): string | undefined {
	return text.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
}

export function commandDiagnostic(result: CommandResult): string | undefined {
	if (result.exitCode === 0 && !result.timedOut && !result.outputTruncated && !result.error) return undefined;
	const parts = [`${result.command} ${result.args.join(" ")}`.trim()];
	if (result.error) parts.push(`error=${result.error}`);
	if (result.exitCode !== 0 && result.exitCode !== null) parts.push(`exit=${result.exitCode}`);
	if (result.signal) parts.push(`signal=${result.signal}`);
	if (result.timedOut) parts.push("timed out");
	if (result.outputTruncated) parts.push("output truncated");
	const stderr = firstLine(result.stderr);
	if (stderr) parts.push(stderr);
	return parts.join("; ");
}

export function summarizeCommand(result: CommandResult): Record<string, unknown> {
	return {
		command: result.command,
		args: result.args,
		cwd: result.cwd,
		exitCode: result.exitCode,
		signal: result.signal,
		timedOut: result.timedOut,
		outputTruncated: result.outputTruncated,
		stdout: result.stdout.trim().slice(0, 4_000),
		stderr: result.stderr.trim().slice(0, 4_000),
		error: result.error,
	};
}

export function summarizeCommandBrief(result: CommandResult): Record<string, unknown> {
	return {
		command: result.command,
		args: result.args,
		cwd: result.cwd,
		exitCode: result.exitCode,
		signal: result.signal,
		timedOut: result.timedOut,
		outputTruncated: result.outputTruncated,
		stderr: result.stderr.trim().slice(0, 1_000),
		error: result.error,
	};
}

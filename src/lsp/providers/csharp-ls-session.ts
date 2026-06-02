import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { commandDiagnostic, runCommand } from "../../exec.ts";
import { ensureInsideRoot } from "../../repo.ts";
import { LspSession, type OpenedTextDocument } from "../lsp-session.ts";

const CSHARP_LS_IDLE_TIMEOUT_MS = 5 * 60 * 1_000;
const CSHARP_LS_MAX_AGE_MS = 30 * 60 * 1_000;
const PROJECT_GRAPH_EXTENSIONS = new Set([".sln", ".slnx", ".csproj", ".props", ".targets"]);
const PROJECT_GRAPH_FILES = new Set(["global.json", "nuget.config", "packages.lock.json"]);
const EXCLUDED_GRAPH_DIRS = new Set([".git", ".hg", ".svn", "node_modules", "bin", "obj", "dist", "build", "target", ".cache", "out", "StrykerOutput"]);

interface OpenDocumentState {
	document: OpenedTextDocument;
	hash: string;
	version: number;
}

interface CSharpLsSessionEntry {
	key: string;
	executable: string;
	repoRoot: string;
	workspaceRoot: string;
	projectGraphHash: string;
	session: LspSession;
	opened: Map<string, OpenDocumentState>;
	createdAt: number;
	lastUsed: number;
	version?: string;
	idleTimer?: ReturnType<typeof setTimeout>;
}

export interface CSharpLsSessionLease {
	executable: string;
	workspaceRoot: string;
	version?: string;
	persistent: boolean;
	reused: boolean;
	restarted: boolean;
	session: LspSession;
	openDocument(file: string, languageId: string, options?: { forceChange?: boolean }): OpenedTextDocument;
}

export interface CSharpLsSessionRunResult<T> {
	result: T;
	diagnostics: string[];
	executable: string;
	workspaceRoot: string;
	version?: string;
	persistent: boolean;
	reused: boolean;
	restarted: boolean;
}

export interface CSharpLsSessionOptions {
	repoRoot: string;
	workspaceRoot: string;
	executable: string;
	timeoutMs: number;
	persistent?: boolean;
	signal?: AbortSignal;
}

const sessionCache = new Map<string, CSharpLsSessionEntry>();
const sessionQueues = new Map<string, Promise<void>>();

function findWorkspaceRoot(repoRoot: string, file?: string): string | undefined {
	let directory = repoRoot;
	if (file) {
		try {
			directory = path.dirname(path.resolve(repoRoot, ensureInsideRoot(repoRoot, file)));
		} catch {
			directory = repoRoot;
		}
	}
	while (true) {
		const entries = fs.existsSync(directory) ? fs.readdirSync(directory) : [];
		if (entries.some((entry) => entry.endsWith(".sln") || entry.endsWith(".slnx") || entry.endsWith(".csproj"))) return directory;
		if (directory === repoRoot) return undefined;
		const parent = path.dirname(directory);
		if (parent === directory || !path.relative(repoRoot, parent).startsWith("..")) directory = parent;
		else return undefined;
	}
}

export function csharpLsWorkspaceRoot(repoRoot: string, files: string[] = []): string {
	for (const file of files) {
		const workspaceRoot = findWorkspaceRoot(repoRoot, file);
		if (workspaceRoot) return workspaceRoot;
	}
	return findWorkspaceRoot(repoRoot) ?? repoRoot;
}

function contentHash(source: string): string {
	return createHash("sha256").update(source).digest("hex");
}

function sessionKey(options: Pick<CSharpLsSessionOptions, "repoRoot" | "workspaceRoot" | "executable">): string {
	return [path.resolve(options.repoRoot), path.resolve(options.workspaceRoot), path.resolve(options.executable)].join("\0");
}

function isProjectGraphFile(name: string): boolean {
	return PROJECT_GRAPH_EXTENSIONS.has(path.extname(name)) || PROJECT_GRAPH_FILES.has(name.toLowerCase());
}

function collectProjectGraphFiles(repoRoot: string): string[] {
	const files: string[] = [];
	const visit = (directory: string): void => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(directory, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const absolute = path.join(directory, entry.name);
			if (entry.isDirectory()) {
				if (!EXCLUDED_GRAPH_DIRS.has(entry.name)) visit(absolute);
				continue;
			}
			if (!entry.isFile() || !isProjectGraphFile(entry.name)) continue;
			try {
				files.push(ensureInsideRoot(repoRoot, absolute));
			} catch {
				// Ignore files that resolve outside the repository root.
			}
		}
	};
	visit(repoRoot);
	return files.sort();
}

function projectGraphHash(repoRoot: string): string {
	const hash = createHash("sha256");
	hash.update("csharp-project-graph-v1\0");
	for (const file of collectProjectGraphFiles(repoRoot)) {
		hash.update(file);
		hash.update("\0");
		try {
			hash.update(fs.readFileSync(path.resolve(repoRoot, file)));
		} catch {
			hash.update("<missing>");
		}
		hash.update("\0");
	}
	return hash.digest("hex");
}

async function csharpLsVersion(executable: string, cwd: string, timeoutMs: number): Promise<string | undefined> {
	const result = await runCommand(executable, ["--version"], { cwd, timeoutMs: Math.min(timeoutMs, 5_000), maxOutputBytes: 20_000 });
	if (commandDiagnostic(result)) return undefined;
	return result.stdout.split(/\r?\n/).find(Boolean);
}

function isExpired(entry: CSharpLsSessionEntry, projectHash: string): boolean {
	const now = Date.now();
	return entry.projectGraphHash !== projectHash || now - entry.createdAt > CSHARP_LS_MAX_AGE_MS;
}

async function disposeEntry(entry: CSharpLsSessionEntry): Promise<void> {
	if (entry.idleTimer) clearTimeout(entry.idleTimer);
	sessionCache.delete(entry.key);
	entry.opened.clear();
	await entry.session.shutdown();
}

function scheduleIdleShutdown(entry: CSharpLsSessionEntry): void {
	if (entry.idleTimer) clearTimeout(entry.idleTimer);
	entry.idleTimer = setTimeout(() => {
		void disposeEntry(entry).catch(() => undefined);
	}, CSHARP_LS_IDLE_TIMEOUT_MS);
	entry.idleTimer.unref?.();
}

async function createEntry(options: CSharpLsSessionOptions, projectHash: string, persistent: boolean, diagnostics: string[]): Promise<CSharpLsSessionEntry> {
	const session = new LspSession({
		command: options.executable,
		cwd: options.workspaceRoot,
		repoRoot: options.repoRoot,
		rootUri: pathToFileURL(options.workspaceRoot).href,
		timeoutMs: options.timeoutMs,
		signal: persistent ? undefined : options.signal,
		name: "csharp-ls",
	});
	const init = await session.initialize();
	if (init.error) diagnostics.push(`initialize: ${init.error.message ?? "csharp-ls error"}`);
	const version = await csharpLsVersion(options.executable, options.workspaceRoot, options.timeoutMs);
	return {
		key: sessionKey(options),
		executable: options.executable,
		repoRoot: options.repoRoot,
		workspaceRoot: options.workspaceRoot,
		projectGraphHash: projectHash,
		session,
		opened: new Map(),
		createdAt: Date.now(),
		lastUsed: Date.now(),
		version,
	};
}

function openOrRefreshDocument(entry: CSharpLsSessionEntry, file: string, languageId: string, options: { forceChange?: boolean } = {}): OpenedTextDocument {
	const safeFile = ensureInsideRoot(entry.repoRoot, file);
	const text = fs.readFileSync(path.resolve(entry.repoRoot, safeFile), "utf-8");
	const hash = contentHash(text);
	const current = entry.opened.get(safeFile);
	if (!current) {
		const document = entry.session.didOpen(safeFile, languageId, text);
		entry.opened.set(safeFile, { document, hash, version: document.version });
		return document;
	}
	if (current.hash === hash && options.forceChange !== true) return current.document;
	const version = current.version + 1;
	const document = entry.session.didChange(current.document, text, version);
	entry.opened.set(safeFile, { document, hash, version });
	return document;
}

async function withSessionQueue<T>(key: string, run: () => Promise<T>): Promise<T> {
	const previous = sessionQueues.get(key) ?? Promise.resolve();
	let release!: () => void;
	const current = new Promise<void>((resolve) => {
		release = resolve;
	});
	const queued = previous.catch(() => undefined).then(() => current);
	sessionQueues.set(key, queued);
	await previous.catch(() => undefined);
	try {
		return await run();
	} finally {
		release();
		if (sessionQueues.get(key) === queued) sessionQueues.delete(key);
	}
}

export async function withCSharpLsSession<T>(options: CSharpLsSessionOptions, run: (lease: CSharpLsSessionLease) => Promise<T>): Promise<CSharpLsSessionRunResult<T>> {
	const persistent = options.persistent === true;
	const key = sessionKey(options);
	return await withSessionQueue(key, async () => {
		if (options.signal?.aborted) throw new Error("csharp-ls request aborted");
		const diagnostics: string[] = [];
		const graphHash = projectGraphHash(options.repoRoot);
		let entry = persistent ? sessionCache.get(key) : undefined;
		let reused = !!entry;
		let restarted = false;
		if (entry && isExpired(entry, graphHash)) {
			restarted = true;
			await disposeEntry(entry);
			entry = undefined;
			reused = false;
		}
		if (!entry) {
			entry = await createEntry(options, graphHash, persistent, diagnostics);
			if (persistent) {
				sessionCache.set(key, entry);
				scheduleIdleShutdown(entry);
			}
		}
		entry.lastUsed = Date.now();
		if (persistent) scheduleIdleShutdown(entry);
		try {
			const lease: CSharpLsSessionLease = {
				executable: entry.executable,
				workspaceRoot: entry.workspaceRoot,
				version: entry.version,
				persistent,
				reused,
				restarted,
				session: entry.session,
				openDocument: (file, languageId, openOptions) => openOrRefreshDocument(entry!, file, languageId, openOptions),
			};
			const result = await run(lease);
			entry.lastUsed = Date.now();
			if (persistent) scheduleIdleShutdown(entry);
			return { result, diagnostics, executable: entry.executable, workspaceRoot: entry.workspaceRoot, version: entry.version, persistent, reused, restarted };
		} catch (error) {
			if (persistent) await disposeEntry(entry);
			throw error;
		} finally {
			if (!persistent) await disposeEntry(entry);
		}
	});
}

export async function shutdownCSharpLsSessions(): Promise<void> {
	const entries = [...sessionCache.values()];
	sessionCache.clear();
	await Promise.all(entries.map((entry) => disposeEntry(entry).catch(() => undefined)));
}

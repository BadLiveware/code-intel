import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ensureInsideRoot } from "../repo.ts";

export function repoFileToUri(repoRoot: string, file: string): { uri: string; file: string; absolutePath: string } {
	const safeFile = ensureInsideRoot(repoRoot, file);
	const absolutePath = path.resolve(repoRoot, safeFile);
	return { uri: pathToFileURL(absolutePath).href, file: safeFile, absolutePath };
}

export function uriToRepoFile(repoRoot: string, uri: string): string {
	const absolutePath = uri.startsWith("file://") ? fileURLToPath(uri) : uri;
	return ensureInsideRoot(repoRoot, absolutePath);
}

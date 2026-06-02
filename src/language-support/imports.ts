function goImports(source: string): string[] {
	const imports: string[] = [];
	for (const match of source.matchAll(/^import\s+(?:[\w.]+\s+)?"([^"]+)"/gm)) imports.push(match[1]);
	for (const block of source.matchAll(/^import\s*\(([^]*?)^\)/gm)) {
		for (const match of block[1].matchAll(/(?:^|\n)\s*(?:[\w.]+\s+)?"([^"]+)"/g)) imports.push(match[1]);
	}
	return [...new Set(imports)].slice(0, 200);
}

export function importsFor(language: string | undefined, source: string): string[] {
	if (language === "go") return goImports(source);
	const imports: string[] = [];
	for (const line of source.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let match: RegExpExecArray | null = null;
		if (language === "cpp") match = /^#\s*include\s*[<"]([^>"]+)/.exec(trimmed);
		else if (language === "csharp") match = /^(?:global\s+)?using\s+(?:static\s+)?([^;=]+)(?:\s*=\s*[^;]+)?;/.exec(trimmed);
		else if (language === "go") match = /^import\s+(?:[\w.]+\s+)?"([^"]+)"/.exec(trimmed);
		else if (language === "rust") match = /^(?:pub\s+)?(?:use\s+([^;]+)|mod\s+([A-Za-z_][\w]*))\s*;/.exec(trimmed);
		else if (language === "python") match = /^(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/.exec(trimmed);
		else if (language === "bash" || language === "zsh") match = /^(?:source|\.)\s+([^\s;&|]+)/.exec(trimmed) ?? /^autoload\s+(?:-[A-Za-z]+\s+)*([^\s;&|]+)/.exec(trimmed);
		else if (language === "markdown") match = /\[[^\]]+\]\(([^)]+)\)/.exec(trimmed) ?? /^\s*\[[^\]]+\]:\s+(\S+)/.exec(trimmed) ?? /^```\s*([A-Za-z0-9_+.-]+)/.exec(trimmed);
		else match = /^import\s+(?:.+?\s+from\s+)?["']([^"']+)["']/.exec(trimmed) ?? /^export\s+.+?\s+from\s+["']([^"']+)["']/.exec(trimmed);
		const value = match?.[1] ?? match?.[2];
		if (value) imports.push(value.trim());
	}
	if (language === "typescript" || language === "tsx" || language === "javascript") {
		for (const match of source.matchAll(/\b(?:import|require)\(\s*["']([^"']+)/g)) imports.push(match[1]);
	}
	return [...new Set(imports)].slice(0, 200);
}

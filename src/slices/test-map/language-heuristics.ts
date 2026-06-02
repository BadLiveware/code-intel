import * as fs from "node:fs";
import * as path from "node:path";

interface DirectoryLike {
	path: string;
	children?: DirectoryLike[];
}

interface ScanLike {
	directories: DirectoryLike[];
}

export interface TestMapScanFile {
	path: string;
	absolutePath: string;
	language?: string;
	category: "source" | "test" | "doc" | "config" | "other";
}

const TEST_ROOT_NAMES = new Set(["test", "tests", "__tests__", "spec", "integration", "queries", "gtest", "bats", "shellspec"]);
const TEST_DIR_PATTERN = /(^|\/)(__tests__|test|tests|spec|integration|gtest|queries|stateless|bats|shellspec)(\/|$)/i;
const LOW_SIGNAL_PATH_TERMS = new Set(["apply", "function", "functions", "range", "over", "time", "timeseries", "test", "tests", "query", "queries"]);

const LANGUAGE_TEST_PATTERNS: Record<string, RegExp[]> = {
	csharp: [/\.tests?\.[^/]+\.cs$/i, /(^|\/)[^/]*(tests?|specs?)\.cs$/i, /(^|\/)[^/]*(Should|Facts)\.cs$/i],
	bash: [/\.bats$/i, /(^|\/)[^/]*(test|spec)[^/]*\.(sh|bash)$/i, /(^|\/)(bats|shellspec|shunit2)(\/|$)/i],
	zsh: [/\.bats$/i, /(^|\/)[^/]*(test|spec)[^/]*\.(sh|zsh)$/i, /(^|\/)(bats|shellspec)(\/|$)/i],
	python: [/(^|\/)test_[^/]*\.py$/i, /(^|\/)[^/]*_test\.py$/i],
	rust: [/(^|\/)tests\/.*\.rs$/i, /(^|\/)[^/]*(test|spec)[^/]*\.rs$/i],
	cpp: [/(^|\/)[^/]*(test|tests|spec|gtest|catch|doctest)[^/]*\.(c|cc|cpp|cxx|h|hh|hpp|hxx)$/i],
	markdown: [/(^|\/)(docs?|examples?).*(test|spec|check)/i, /(markdownlint|markdown-link-check|link-check|lychee|doctest|vale)/i],
	typescript: [/(^|\/)(__tests__|tests?|spec)(\/|$)/i, /\.(test|spec)\.[cm]?[tj]sx?$/i, /(^|\/)(e2e|playwright|cypress)(\/|$)/i],
	tsx: [/(^|\/)(__tests__|tests?|spec)(\/|$)/i, /\.(test|spec)\.[cm]?[tj]sx?$/i, /(^|\/)(e2e|playwright|cypress)(\/|$)/i],
	javascript: [/(^|\/)(__tests__|tests?|spec)(\/|$)/i, /\.(test|spec)\.[cm]?[tj]sx?$/i, /(^|\/)(e2e|playwright|cypress)(\/|$)/i],
	go: [/[^/]+_test\.go$/i],
};

const LANGUAGE_TEST_LITERALS: Record<string, string[]> = {
	csharp: ["[Fact]", "[Theory]", "[Test]", "[TestMethod]", "Assert."],
	bash: ["bats", "@test", "Describe", "It", "assert_success", "shunit2"],
	zsh: ["bats", "@test", "Describe", "It", "assert_success"],
	python: ["def test_", "class Test", "pytest", "unittest", "assert "],
	rust: ["#[test]", "#[cfg(test)]", "mod tests", "assert_eq!", "assert!"],
	cpp: ["TEST(", "TEST_F(", "SCENARIO(", "doctest", "Catch2", "EXPECT_", "ASSERT_"],
	markdown: ["markdown-link-check", "markdownlint", "lychee", "doctest", "link check"],
};

export function defaultTestPaths(scan: ScanLike): string[] {
	const dirs = new Set<string>();
	function visit(dir: DirectoryLike): void {
		const base = path.posix.basename(dir.path).toLowerCase();
		if (TEST_ROOT_NAMES.has(base)) dirs.add(dir.path);
		for (const child of dir.children ?? []) visit(child);
	}
	for (const dir of scan.directories) visit(dir);
	return [...dirs].sort();
}

export function tokensForPath(file: string): string[] {
	const stem = path.posix.basename(file).replace(/\.[^.]+$/, "");
	return [...new Set(stem.split(/[^A-Za-z0-9]+|(?=[A-Z])/).map((part) => part.toLowerCase()).filter((part) => part.length >= 3 && !LOW_SIGNAL_PATH_TERMS.has(part)))];
}

export function testMapTerms(safePath: string | undefined, explicitTerms: string[]): string[] {
	return [...new Set([...explicitTerms, ...(safePath ? tokensForPath(safePath) : [])].filter((term) => term.length >= 2))];
}

export function testSearchPaths(testRoots: string[], safePath: string | undefined, sourceLanguage: string | undefined): string[] {
	const output = new Set(testRoots.length > 0 ? testRoots : ["tests", "test"]);
	if (safePath) {
		const sourceDir = path.posix.dirname(safePath);
		output.add(sourceDir === "." ? "." : sourceDir);
	}
	if (sourceLanguage === "rust" && safePath) output.add(safePath);
	if (sourceLanguage === "markdown") output.add(".");
	return [...output].sort();
}

function languagePatternMatches(file: string, sourceLanguage: string | undefined): boolean {
	if (!sourceLanguage) return false;
	return (LANGUAGE_TEST_PATTERNS[sourceLanguage] ?? []).some((pattern) => pattern.test(file));
}

function isMarkdownTestArtifact(file: TestMapScanFile, sourceLanguage: string | undefined): boolean {
	return sourceLanguage === "markdown" && (file.category === "config" || file.category === "test" || TEST_DIR_PATTERN.test(file.path)) && languagePatternMatches(file.path, "markdown");
}

export function isNoisyTestArtifact(file: string): boolean {
	return /(^|\/)__pycache__(\/|$)/.test(file) || /\.(pyc|pyo|log|tmp|out|err)$/i.test(file) || /(^|\/)node\/logs\//.test(file);
}

export function shouldConsiderTestCandidate(file: TestMapScanFile, sourceLanguage: string | undefined): boolean {
	if (isNoisyTestArtifact(file.path)) return false;
	if (file.category === "test" || TEST_DIR_PATTERN.test(file.path)) return true;
	if (languagePatternMatches(file.path, sourceLanguage)) return true;
	if (sourceLanguage === "rust" && file.category === "source" && /\.rs$/i.test(file.path)) return true;
	return isMarkdownTestArtifact(file, sourceLanguage);
}

function addPathEvidence(file: string, targetPath: string | undefined, terms: string[], evidence: Record<string, unknown>[]): number {
	let score = 0;
	const seenEvidence = new Set<string>();
	const addEvidence = (kind: string, term: string, points: number): void => {
		const key = `${kind}\0${term}`;
		if (seenEvidence.has(key)) return;
		seenEvidence.add(key);
		score += points;
		evidence.push({ kind, term });
	};
	const fileLower = file.toLowerCase();
	if (targetPath) {
		const targetStem = path.posix.basename(targetPath).replace(/\.[^.]+$/, "").toLowerCase();
		if (fileLower.includes(targetStem)) addEvidence("path_basename", targetStem, 6);
		for (const token of tokensForPath(targetPath)) if (fileLower.includes(token)) addEvidence("path_term", token, 2);
	}
	for (const term of terms) {
		if (LOW_SIGNAL_PATH_TERMS.has(term.toLowerCase())) continue;
		if (fileLower.includes(term.toLowerCase())) addEvidence("path_term", term, 3);
	}
	return score;
}

function literalMatches(file: TestMapScanFile, terms: string[], maxMatches: number): Record<string, unknown>[] {
	const evidence: Record<string, unknown>[] = [];
	let source: string;
	try {
		source = fs.readFileSync(file.absolutePath, "utf-8");
	} catch {
		return evidence;
	}
	const lines = source.split(/\r?\n/);
	for (const term of terms) {
		if (evidence.length >= maxMatches) break;
		const needle = term.toLowerCase();
		for (let index = 0; index < lines.length; index++) {
			if (lines[index].toLowerCase().includes(needle)) {
				evidence.push({ kind: "literal_match", term, line: index + 1 });
				break;
			}
		}
	}
	return evidence;
}

export function candidateScore(file: TestMapScanFile, options: { targetPath?: string; terms: string[]; explicitTerms: string[]; sourceLanguage?: string; maxLiteralMatches: number }): { score: number; evidence: Record<string, unknown>[] } {
	const evidence: Record<string, unknown>[] = [];
	let score = addPathEvidence(file.path, options.targetPath, options.terms, evidence);
	if (languagePatternMatches(file.path, options.sourceLanguage)) {
		score += 4;
		evidence.push({ kind: "language_test_pattern", term: options.sourceLanguage });
	}
	const literalTerms = [...new Set([...options.explicitTerms, ...(LANGUAGE_TEST_LITERALS[options.sourceLanguage ?? ""] ?? [])])];
	const literalEvidence = literalMatches(file, literalTerms, options.maxLiteralMatches);
	const frameworkMatches = new Set(LANGUAGE_TEST_LITERALS[options.sourceLanguage ?? ""] ?? []);
	for (const row of literalEvidence) evidence.push(row);
	for (const row of literalEvidence) score += frameworkMatches.has(String(row.term)) ? 2 : 5;
	return { score, evidence };
}

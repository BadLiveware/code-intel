# code-intel

[![CI](https://github.com/BadLiveware/code-intel/actions/workflows/ci.yml/badge.svg)](https://github.com/BadLiveware/code-intel/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Standalone code-intelligence CLI and MCP server for source routing, impact maps, file outlines, syntax search, and bounded symbol reads.

The package is designed for agent harnesses such as Claude Code that need a read-next helper without loading the Pi extension runtime.

## Install and build

```bash
npm install
npm run build
```

If a Claude MCP config uses the short `code-intel` command, make the local checkout available on `PATH` first:

```bash
npm link
command -v code-intel
code-intel list
```

Alternatively, configure Claude with the absolute built entrypoint path shown below.

The normal executable entrypoint is the built bin:

```bash
./dist/standalone/cli.js list
./dist/standalone/cli.js call code_intel_file_outline --cwd src --json '{"path":"tool-registry.ts","maxSymbols":5}'
./dist/standalone/cli.js mcp
./dist/standalone/cli.js mcp --cwd /path/to/repo  # optional pinned repo launch
```

When linked or installed, use the short command:

```bash
code-intel list
code-intel mcp
code-intel mcp --cwd /path/to/repo  # optional pinned repo launch
```

The TypeScript source entrypoint can still be run with `node --experimental-strip-types` for local debugging, but normal CLI/MCP use should run the built JavaScript bin.

## Claude Code MCP setup

After building and linking/installing the package, add code-intel from the repository you want Claude Code to inspect. The short command requires `command -v code-intel` to succeed; otherwise use the absolute `dist/standalone/cli.js` path from [docs/claude-code-mcp.md](docs/claude-code-mcp.md).

```bash
cd /path/to/repo
claude mcp add -s project code-intel -- code-intel mcp
```

`--cwd /path/to/repo` is only for a deliberately pinned server, such as a one-off config launched from outside the target repo. It is not a generic install-time value.

For source-checkout configuration and smoke-test guidance, see [docs/claude-code-mcp.md](docs/claude-code-mcp.md).

## Tools

Read-only tools are exposed by default:

- `code_intel_state`
- `code_intel_repo_overview`
- `code_intel_file_outline`
- `code_intel_repo_route`
- `code_intel_test_map`
- `code_intel_impact_map`
- `code_intel_local_map`
- `code_intel_syntax_search`
- `code_intel_read_symbol`
- `code_intel_post_edit_map`

Mutation tools are opt-in and appear when `--enable-mutations` is passed:

- `code_intel_replace_symbol`
- `code_intel_insert_relative`

Enable them when you want symbol-aware edits that consume code-intel targets and hash/text safety evidence. They complement generic edit tools by avoiding manual line-range reconstruction, relocating stale symbol targets, and keeping declaration-sized replacements or insertions anchored to parsed source. Leave them disabled only when the MCP client should be read-only.

## Path behavior

`--cwd` overrides the server working directory when the MCP client launches code-intel from somewhere other than the target repo. If omitted, code-intel uses the process working directory. The standalone server defaults to `--path-base auto`, which accepts either repo-root-relative paths or cwd-relative paths for tool fields such as `path`, `paths`, `changedFiles`, and `testPaths`.

In `auto` mode, code-intel first tries the input as repo-root-relative when that file exists; otherwise it resolves the path relative to the server working directory. Use `--path-base repo` or `--path-base cwd` to force one interpretation.

Broad scans respect git ignore rules by default using tracked plus unignored working-tree files. Explicit file paths remain inspectable even when ignored, and explicit ignored directories such as `obj/` can be scanned deliberately. Use `includeIgnored: true` on routing/search tools when generated outputs such as source-generator `.g.cs` files should be included in broad candidate discovery.

Long-lived MCP sessions cache parsed files and extracted symbol records by current content hash. The server reads and hashes the file before reusing a cached entry, so edits invalidate cached parse/record data instead of returning stale source facts.

For C# impact maps, `confirmReferences: "csharp-ls"` promotes exact csharp-ls reference rows into the returned `related` candidates before syntax-only rows, while preserving the separate `referenceConfirmation` details for diagnostics and coverage. Long-lived MCP sessions keep a bounded csharp-ls workspace session warm, refresh open file text by content hash with full-document `didChange`, and restart the server when C# project graph files change.

`code_intel_post_edit_map` compact output starts with next read/validation actions before declaration details. Its structured details include `changedFileContexts`, `projectBoundaryFiles`, `nonSymbolChangedFiles`, and `validationHints` so project/build changes such as `.csproj` files stay visible even when they do not produce declaration symbols.

Post-edit diagnostic rows include `provenance`, `provider`, `source`, `freshness`, and `baselineStatus`. Caller-supplied diagnostics default to `freshness: "unknown"`; collected diagnostics report the provider confidence they can cheaply establish. `baselineStatus: "not-compared"` means the row is current touched-file evidence, not proof that the diagnostic is newly introduced. Post-edit results also include `phaseTimings`; compact output renders phase timing only when a phase is slow, failed, or aborted, and completed phase rows are preserved in partial results.

`code_intel_repo_route` ranks path, declaration-like, source literal, test, and documentation evidence separately. Broad or truncated queries return concise narrowing guidance; generic terms such as `load` or `run` are useful only when paired with domain terms or scoped `paths`. When only a small remainder is truncated, the result includes `remainingCount` and `nextOffset`; rerun with the same query plus `offset: nextOffset` to inspect the next page without increasing `maxResults` or reprinting page 1.

## Configuration

Standalone config is loaded in this order:

1. Pi user config: `~/.pi/agent/code-intelligence.json`
2. Standalone user config: `~/.config/code-intelligence/config.json`
3. Project config: `.pi/code-intelligence.json` under `--cwd`
4. Explicit `--config` path
5. Inline overrides from code

Defaults:

```json
{
  "maxResults": 125,
  "queryTimeoutMs": 30000,
  "maxOutputBytes": 5000000
}
```

## Development

```bash
npm run typecheck
npm test
npm run build
npm run smoke:cli
npm run pack:dry-run
```

For the full local CI sequence, run:

```bash
npm run ci
```

CI runs on Node.js 24 because the source test suite uses Node's built-in test runner with `node --experimental-strip-types` for TypeScript test files. The built CLI/MCP path is validated by `npm run build`, `npm run smoke:cli`, and `npm run pack:dry-run`.

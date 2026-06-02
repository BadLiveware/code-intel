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

# code-intel

Standalone code-intelligence CLI and MCP server for source routing, impact maps, file outlines, syntax search, and bounded symbol reads.

The package is designed for agent harnesses such as Claude Code that need a read-next helper without loading the Pi extension runtime.

## Install and build

```bash
npm install
npm run build
```

The normal executable entrypoint is the built bin:

```bash
./dist/standalone/cli.js list
./dist/standalone/cli.js call code_intel_file_outline --cwd src --json '{"path":"tool-registry.ts","maxSymbols":5}'
./dist/standalone/cli.js mcp --cwd /path/to/repo
```

When linked or installed, use the short command:

```bash
code-intel list
code-intel mcp --cwd /path/to/repo
```

The TypeScript source entrypoint can still be run with `node --experimental-strip-types` for local debugging, but normal CLI/MCP use should run the built JavaScript bin.

## Claude Code MCP setup

After building and linking/installing the package:

```bash
claude mcp add code-intel -- code-intel mcp --cwd /path/to/repo
```

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

Mutation tools are hidden unless `--enable-mutations` is passed:

- `code_intel_replace_symbol`
- `code_intel_insert_relative`

Keep mutations disabled for ordinary Claude Code use; Claude Code already has edit tools, while code-intel is primarily a routing and source-context helper.

## Path behavior

`--cwd` sets the process working directory. The standalone server defaults to `--path-base auto`, which accepts either repo-root-relative paths or cwd-relative paths for tool fields such as `path`, `paths`, `changedFiles`, and `testPaths`.

In `auto` mode, code-intel first tries the input as repo-root-relative when that file exists; otherwise it resolves the path relative to `--cwd`. Use `--path-base repo` or `--path-base cwd` to force one interpretation.

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

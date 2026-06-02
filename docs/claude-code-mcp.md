# Claude Code MCP Setup

Run code-intelligence as a Claude Code MCP server when another harness needs Pi's read-next maps, outlines, and symbol reads without loading the Pi extension runtime.

## Prerequisites

- Claude Code CLI on `PATH` (`claude --version`).
- Node.js 20 or newer.
- Dependencies installed in this package (`npm install`).
- A target repository. For project-scoped MCP setup, run the add command from that repository root. Use `--cwd` only when intentionally pinning the server to a repo path.

## Source checkout configuration

Build the standalone CLI once from the source checkout:

```bash
cd /path/to/code-intel
npm install
npm run build
```

If you want Claude to launch the short `code-intel` command, link or install the package so the command resolves on `PATH`:

```bash
npm link
command -v code-intel
code-intel list
```

If `command -v code-intel` prints nothing, Claude will report `ENOENT` when it tries to spawn the MCP server. Use the absolute built entrypoint path below, or link/install the package first.

Create an MCP config file that launches the built standalone entrypoint. This one-off config pins the target repo because it may be used from outside that repo:

```json
{
  "mcpServers": {
    "code-intel": {
      "type": "stdio",
      "command": "/path/to/code-intel/dist/standalone/cli.js",
      "args": [
        "mcp",
        "--cwd",
        "/path/to/repo"
      ]
    }
  }
}
```

Use it for a one-off Claude Code run:

```bash
claude -p \
  --mcp-config /path/to/code-intel-mcp.json \
  --strict-mcp-config \
  --permission-mode bypassPermissions \
  'Use code-intel to outline src/index.ts before deciding what source to read next.'
```

For persistent project configuration, run Claude Code's MCP command from the repository that code-intel should inspect and omit `--cwd`:

```bash
cd /path/to/repo
claude mcp add -s project code-intel -- \
  /path/to/code-intel/dist/standalone/cli.js \
  mcp
```

Add `--cwd /path/to/repo` only for a deliberately pinned local/user config that should always inspect that one repository, regardless of where Claude Code is launched. If you have not linked or installed the `code-intel` bin, use the absolute `/path/to/code-intel/dist/standalone/cli.js` command in this setup.

## Available tools

The MCP server exposes read-only tools by default:

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

Mutation tools are opt-in and appear when the server starts with `--enable-mutations`:

- `code_intel_replace_symbol`
- `code_intel_insert_relative`

Enable them when a Claude Code workflow should use code-intel's symbol-aware edit path. These tools complement generic edit tools by consuming stable symbol targets plus hash/text safety evidence, relocating stale anchors, and applying declaration-sized replacements or insertions without reconstructing line ranges by hand. Leave them disabled only when the MCP client should be read-only.

## Path behavior

`--cwd` overrides the server working directory when the MCP client launches code-intel from somewhere other than the target repo. If omitted, code-intel uses the process working directory. The standalone server defaults to `--path-base auto`, which accepts either repo-root-relative paths or cwd-relative paths for tool fields such as `path`, `paths`, `changedFiles`, and `testPaths`.

Examples:

```json
{"path":"src/index.ts"}
{"changedFiles":["src/index.ts"]}
{"changedFiles":["src/tool-registry.ts"]}
```

In `auto` mode, code-intel first tries the input as repo-root-relative when that file exists; otherwise it resolves the path relative to the server working directory. Use `--path-base repo` to force repo-root-relative behavior, or `--path-base cwd` to force cwd-relative behavior.

Broad scans respect git ignore rules by default using tracked plus unignored working-tree files. This keeps build outputs such as C# `obj/` and `bin/` out of normal routing. Explicit file paths remain inspectable even when ignored, and explicit ignored directories can be scanned deliberately. Use `includeIgnored: true` when generated outputs such as source-generator `.g.cs` files should participate in broad candidate discovery.

Long-lived MCP sessions cache parsed files and extracted symbol records by current content hash. The server reads and hashes the file before reusing a cached entry, so edits invalidate cached parse/record data instead of returning stale source facts. For C# impact maps, `confirmReferences: "csharp-ls"` promotes exact csharp-ls reference rows into `related` before syntax-only rows while retaining `referenceConfirmation` details.

Claude Code cannot currently supply Pi's session-tracked touched files. For `code_intel_post_edit_map`, pass `changedFiles` or `baseRef` explicitly.

## Smoke test

Use Claude Code print mode with stream JSON when you need visible evidence that the MCP tools were called:

```bash
claude -p --verbose \
  --mcp-config /path/to/code-intel-mcp.json \
  --strict-mcp-config \
  --permission-mode bypassPermissions \
  --output-format stream-json \
  'Use code_intel_file_outline, code_intel_impact_map, and code_intel_read_symbol on the code-intelligence standalone registry. Return the tool names you used and whether the server behaved as a read-next helper.' \
  | tee /tmp/code-intel-cc-smoke.jsonl
```

Expected evidence:

- `tools/list` includes the read-only code-intel tools.
- The run includes calls to `code_intel_file_outline`, `code_intel_impact_map`, and `code_intel_read_symbol`.
- Tool results include `ok:true`, bounded location/source payloads, `readHint` or `nextRead*` fields, and limitations that remind the agent to inspect current source before claims.

## Installed package shape

The package declares a `code-intel` bin backed by `dist/standalone/cli.js`. After `npm run build` and package linking/installation, the project-scoped MCP command can be shortened to:

```bash
cd /path/to/repo
claude mcp add -s project code-intel -- code-intel mcp
```

This shortened form assumes `command -v code-intel` succeeds. If it does not, link/install the package or use the absolute built entrypoint path.

For source-only debugging, the TypeScript entrypoint still works with `node --experimental-strip-types`, but the built bin is the preferred normal-use path.

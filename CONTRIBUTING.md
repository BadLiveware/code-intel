# Contributing

Thanks for helping improve code-intel.

## Local setup

```bash
npm install
npm run ci
```

`npm run ci` typechecks, runs tests, builds the standalone CLI, smokes the built CLI, and verifies the package contents with `npm pack --dry-run`.

## Development guidelines

- Keep the standalone package independent from Pi-specific runtime APIs.
- Keep tool descriptions, schemas, and execution behavior in the shared specs under `src/slices/**/spec*.ts`.
- Keep adapter-specific behavior narrow and explicit.
- Prefer small, reviewable commits with tests or smoke evidence for behavior changes.
- Do not commit generated `dist/`, package tarballs, `node_modules/`, local caches, or editor state.

## Reporting issues

Open a GitHub issue with:

- the command or MCP client action you ran
- the repository/path shape involved, especially `--cwd` and path arguments
- expected behavior and actual behavior
- relevant `code_intel_state` output when parser, rg, or language-server behavior is involved

For security-sensitive reports, see [SECURITY.md](SECURITY.md).

# Security Policy

## Supported versions

Security fixes are handled on the `main` branch until versioned releases are established.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting or repository security advisory flow when it is available. If private reporting is unavailable, open a GitHub issue that asks for a private contact path and does not include exploit details, secrets, or sensitive repository data.

Please include:

- affected command, MCP tool, or configuration surface
- minimal reproduction steps or a concise impact description
- whether the issue exposes local source, secrets, paths outside the requested repo, or unexpected file mutation

## Security boundaries

code-intel is a local developer tool. It reads source files from repositories requested by the caller and can optionally expose mutation tools only when started with `--enable-mutations`.

Default MCP mode is read-only. Keep mutation tools disabled for untrusted clients or routine Claude Code use.

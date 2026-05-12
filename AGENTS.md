# Agent Instructions

Canonical guidance for any AI coding agent (Claude Code, Cursor, Aider, ...)
working in this repository.

## Project shape

- **MCP connector only.** This plugin ships `.mcp.json` +
  `openclaw.plugin.json` — no application code. meshx's native MCP
  server (`meshx mcp start`) provides the 26 tools; this repo tells
  OpenClaw how to spawn it.
- **No build step.** No TypeScript, no compilation, no `node_modules`.
  Install is `openclaw plugins install .` or `openclaw mcp set`.
- **Conventional Commits.** Same rules as
  [meshx](https://github.com/retr0h/meshx/blob/main/docs/contributing.md).

## Key files

| File | Purpose |
|---|---|
| `.mcp.json` | Tells OpenClaw to spawn `meshx mcp start` |
| `openclaw.plugin.json` | ClawHub bundle manifest |
| `package.json` | npm metadata (no deps, no build) |
| `docs/design-mcp-pivot.md` | Architecture notes from the HTTP→MCP pivot |

## What NOT to do

- Don't add TypeScript tools — meshx's MCP server owns the tool surface.
- Don't vendor the OpenAPI spec — mcpgen reads it server-side.
- Don't add runtime dependencies — this is a config-only plugin.

## Related repos

- [meshx](https://github.com/retr0h/meshx) — the daemon + MCP server
  this plugin connects to. All tool implementations live there.

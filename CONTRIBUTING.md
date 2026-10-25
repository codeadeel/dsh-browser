# Contributing

Small, focused PRs against `main`. The CI runs `pnpm typecheck`, `pnpm test`,
and builds the three Docker images.

```bash
pnpm install
pnpm typecheck
pnpm test          # requires Chrome for Testing 156 on PATH (or CHROME_PATH)
```

## Layout

```text
src/search/     search gateway: providers, ranked chain, config store
src/browser/     per-session Chromium, tools, screencast + WS viewer
panel/           DSH plugin: host proxy + native tools (index.js), UI (client.js)
docker/          container entrypoints
test/            vitest suites
```

## Conventions

- Official services first: SearXNG image, Brave MCP server, Gemini/Vertex/CSE
  REST APIs. Self-built code only where no official piece exists (the gateway
  orchestrator and the shared browser runtime).
- Keys never leave the gateway; previews are masked.
- Every provider ships with a parser test and a config-store masking test.

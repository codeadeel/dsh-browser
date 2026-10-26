# Architecture

## Goal

Give a DSH agent a real Chromium browser that a human can watch and share, without a browser extension and without coupling the browser to a DSH plugin version.

## Control and data planes

```mermaid
flowchart TB
  subgraph control["Control plane"]
    UI["DSH Web UI · agent loop · approvals"]
    Link["native browser_* tools<br/>session id = DSH session id<br/>POST /sessions/:id/tool"]
  end
  subgraph data["Data plane"]
    Chrome["dedicated Chromium<br/>one profile per session<br/>cookies · tabs · local storage"]
    Screen["CDP screencast + WS input<br/>for the human"]
  end
  UI --> Link --> Chrome
  Screen <--> Chrome
```

The search gateway is a separate shared service. It is not part of Chromium.

## Components

### Search gateway

- Stateless MCP server exposing `web_search`.
- Ranked provider chain: SearXNG, Google CSE, Gemini, Brave, Vertex, DuckDuckGo.
- Returns URLs and snippets. Does not know about browser sessions.

### Browser session manager

- HTTP API: `POST /sessions`, `GET /sessions`, `DELETE /sessions/:id`, `POST /sessions/:id/tool`.
- Creates one Chromium per session, lazily: the first tool call for a DSH
  session id creates that session's Chromium.
- Tracks `lastActivityAt` and sweeps idle sessions after a configurable timeout.
- Watches `domain/changed`; deleting a workspace closes the browser sessions
  attached to it. DSH removes only the workspace registration and keeps the
  session logs, so the host plugin mirrors the workspace's `sessionIds`.

### Browser tools

- 17 native tools registered by the panel host plugin (navigate, snapshot,
  click, type, press, scroll, tabs, screenshot, search, wait_for, find, batch,
  console, network, ...).
- Puppeteer/CDP drives the dedicated Chromium; `browser_search` detects
  human-verification pages and reports `blocked: true`.

### DSH

- Connects to the search gateway as a generic MCP client.
- Loads `dsh-browser-panel`, whose host half registers the native `browser_*`
  tools and proxies `/dsh-browser/*` to the loopback services.
- Contains no Chromium code; can be upgraded independently.

## Session lifecycle

```mermaid
flowchart LR
  A["agent calls a browser_* tool"] --> B["host plugin reads the DSH session id"]
  B --> C["browser service creates that session's Chromium"]
  C --> D["agent browses · human watches / takes over"]
  D -->|"workspace deleted"| G["DELETE attached browser sessions"]
  D --> E["idle timeout"]
  E --> F["Chromium stops · profile removed"]
```

## Hybrid search flow

```mermaid
flowchart LR
  A["web_search(query)"] --> B["gateway returns URLs"]
  B --> C["agent picks a URL"]
  C --> D["browser_navigate(url)"]
  D --> E["browser_snapshot()"]
  E --> F["browser_click / browser_type"]
  F --> G["answer with citations"]
```

Fallback when the gateway is down:

```mermaid
flowchart LR
  A["gateway unavailable"] --> B["browser_search(query)"]
  B --> C["Google via Chromium"]
  C --> D{"blocked?"}
  D -->|"yes"| E["human completes the check"]
  D -->|"no"| F["results"]
  C --> G["or DuckDuckGo fallback"]
```

## Isolation boundary

Isolation is the browser profile/process, not a tab group.

```mermaid
flowchart LR
  A["Session A"] --> PA["profile A"] --> CA["Chromium A"] --> TA["/sessions/A/tool"]
  B["Session B"] --> PB["profile B"] --> CB["Chromium B"] --> TB["/sessions/B/tool"]
```

A tab group in one profile is not isolation because cookies and logins are shared.

## Local and remote deployment

```mermaid
flowchart LR
  subgraph local["local"]
    L["DSH → session manager → Chromium → native window"]
  end
  subgraph remote["remote"]
    R["DSH → session manager → Chromium container → CDP screencast panel"]
  end
```

The contracts stay the same. The viewer is a CDP screencast; no VNC layer is required.

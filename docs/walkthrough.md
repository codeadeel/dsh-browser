# Walkthrough

A hands-on tour of the DSH browser runtime: start the stack, open the panel,
watch the agent drive a browser, take over, configure search, and verify each
layer. Every check has an expected result so you know it works.

## 0. What is running where

| Port | Service | Binding | Reached via |
|---|---|---|---|
| DSH web port (any) | DSH web UI | public | browser (the only public port) |
| `8790` | browser session manager | loopback | DSH host proxy `/dsh-browser/browser/*` |
| `8791` | viewer (screencast SSE + WS input) | loopback | DSH host proxy `/dsh-browser/viewer/*`, `/dsh-browser/ws` |
| `8787` | search gateway — MCP + settings + health on one port | loopback | DSH MCP client + host proxy `/dsh-browser/search/*` |

The browser session id **is** the DSH session id: the first `browser_*` tool
call by an agent auto-creates that session's Chromium.

## 1. Start the stack

```bash
# the whole backend, one command (searxng + brave-mcp + gateway + browser)
docker compose up -d --build

# DSH with the panel plugin (installed once per profile):
#   UI: Plugins → Add plugin → Install a third-party plugin →
#       paste `github:codeadeel/dsh-browser#path:panel`
#   dev checkout: dsh plugin --profile web add link:/path/to/dsh-browser/panel
dsh plugin --profile web add "github:codeadeel/dsh-browser#path=panel"
dsh --profile web --patch config/dsh-search.patch.yml \
  --no-open --host 0.0.0.0 --port 3000
```

Expected: DSH prints a one-time URL ending in `?token=…`. Open it; the cookie
from that exchange authenticates every `/dsh-browser/*` request from then on.

> The token changes on every DSH restart. Bookmark the new URL each time.

Optional all-in-one containers: `docker compose up -d --build` and
`docker compose --profile web up -d --build` (see the README).

## 2. Quick smoke test (optional)

```bash
curl http://127.0.0.1:8787/health          # {"ok":true}
curl http://127.0.0.1:8790/health          # {"ok":true,"sessions":0}
curl -X POST http://127.0.0.1:8787/test \
  -H 'content-type: application/json' \
  -d '{"query":"DeepSeek R2"}'            # {"ok":true,"provider":"google-gemini",…}
```

## 3. Open the panel

1. In the DSH UI click the **Browser** button (top right, green dot).
2. Expected: a floating card opens showing the live page. If no session
   exists yet it says *Waiting for browser frame…* — create one below.
3. **Session selector** (top of the card): the panel preselects the most
   recently active session and follows it until you pick one manually.
4. **+** creates a fresh isolated session; **⟳** reconnects the feed;
   **⤢** maximizes over the chat (same button restores); **×** collapses
   back to the small Browser button.
5. Resize from any edge or corner; the size persists across reloads.

## 4. Watch the agent, then take over

1. Ask the agent in chat to browse: e.g. *"open https://example.com, summarize
   it, then search for the DeepSeek R2 release date and open the top result."*
2. Watch: the panel streams the same page the agent drives. The footer shows
   `Shared page • click or type to take over • input: ws` — `ws` confirms the
   WebSocket input channel; `http` would mean it fell back.
3. **Take over at any time**: click, type, scroll, or use the address bar.
   The agent sees your changes on its next `browser_snapshot` — one browser,
   two drivers.
4. Keyboard: all printable keys, Backspace/Tab/Enter/Escape/arrows/Home/End/
   PageUp/PageDown, and Ctrl/Cmd+A/C/X/V/Z/Y (forwarded as native editing
   commands).

## 5. Address bar and tabs

- Type a URL, hostname, or plain search text in the address bar and press
  **Go**. Plain text becomes a Google search.
- The tabs strip lists every tab of the current session: click to switch,
  **×** to close, **+** for a new tab.

## 6. Search settings (own page, not DSH settings)

1. In the DSH UI open **Plugins → dsh-browser-panel**.
2. Choose the provider lane:
   - **Auto** — SearXNG → CSE → Gemini → Vertex → DuckDuckGo,
   - **SearXNG** (self-hosted, already running via Docker),
   - **Google Programmable Search** (legacy JSON API — existing customers only),
   - **Google Gemini Search** (whole-web grounding — open-ended like Google),
   - **Google Vertex AI Search** (searches the sites in your data store),
   - **DuckDuckGo**.
3. Google keys are write-only from the UI: the gateway stores them in
   `data/search-config.json` (mode `0600`) and only ever shows a masked
   preview. Blank = keep saved key.
4. **Vertex AI Search** needs three values: the Cloud API key, the GCP
   **project ID**, and the **app ID** of an AI Applications website search
   app (see below).
5. **Test search** runs a live query through the chosen provider and prints
   the raw result JSON.

Expected for Auto: `{"ok":true,"provider":"searxng","results":[…]}`.

### Brave via the official MCP service

1. Put your subscription token in `.env`: `BRAVE_API_KEY=BSA…`.
2. `docker compose up -d --build` — this starts
   Brave's official MCP server and the gateway calls it directly.
3. In **Plugins → dsh-browser-panel**, the Brave row shows **mcp service** —
   move it up/down with the arrows to set its priority.

### Getting a whole-web Google key (Gemini Search)

1. Go to https://aistudio.google.com/apikey and create an API key (sign in
   with your Google account; enable billing for grounding — Gemini 3.x models
   include 5,000 free grounded searches per month).
2. Open **Plugins → dsh-browser-panel** → paste it under **Google Gemini API
   key** → optionally set the model (a Gemini 3 flash model bills per search
   query; `gemini-3.8-flash` is the current default) → Save → Test search.

The gateway asks Gemini to search the web and return a JSON list of
title/url/snippet; grounding citations are the fallback. This is the
open-ended Google lane — no site list needed.

### Getting a site-scoped Vertex key

1. Google Cloud console → create/select a project → search **AI Applications**
   and activate the API.
2. Create a **website search** app: give it a name, add a data store with the
   site(s) to index (leave advanced indexing off).
3. Copy the **app ID** from the Apps page (that's the engine id).
4. APIs & Services → **Credentials → Create credentials → API key**.
5. Paste key + project ID + app ID into **Plugins → dsh-browser-panel** under
   the Vertex fields → Save → Test search.

## 7. Human verification (CAPTCHA) handoff — by design

If the browser hits a Google consent/CAPTCHA page, `browser_search` returns
`blocked: true`, the agent pauses, and the panel shows the yellow
**Human verification likely** banner.

1. Take over in the panel and complete the check (it is a real browser).
2. Tell the agent to retry.

The system never automates CAPTCHA solving — that is a hard rule in the agent
prompt. For volume Google searches use Google Programmable Search instead.

## 8. What the agent sees (tool inventory)

```text
browser_navigate  browser_snapshot  browser_search   browser_click
browser_type      browser_press     browser_scroll   browser_back / _forward / _reload
browser_tabs      browser_screenshot browser_wait_for browser_find
browser_batch     browser_console   browser_network
mcp__search__web_search
```

No per-session MCP patch and no manual session creation. Tool calls carry the
DSH session id, so two DSH sessions can never share a browser profile.

## 9. Verify the four recent features

| Feature | Check |
|---|---|
| Session binding | Ask the agent to browse → its session appears in the panel selector with the DSH session id |
| WS input | Footer says `input: ws`; wheel-scroll the panel, then `curl -X POST http://127.0.0.1:8790/sessions/<id>/tool -d '{"name":"browser_snapshot","args":{}}'` and confirm `scrollY > 0` |
| New tools | Ask the agent to use `browser_wait_for` / `browser_find` / `browser_batch`; or call them directly via `POST /sessions/<id>/tool` |
| Packaging | `docker compose up -d --build` (and `--profile web` for the DSH container); `docker compose logs dsh \| grep '?token='` |

## 10. Troubleshooting

- **Panel says "Waiting for browser frame…"** — the session is on a blank
  page or the viewer is unreachable. Navigate somewhere; check
  `curl http://127.0.0.1:8790/health`.
- **Footer shows `input: http`** — the WS channel dropped; the panel retries
  with backoff and falls back to HTTP POST automatically. Check that DSH was
  started with the current panel plugin installed.
- **401 on the panel** — reopen the printed `?token=` URL; the cookie expired
  or DSH restarted with a new token.
- **Browser service down** — the panel shows `Viewer: …` errors; restart with
  the command in step 1. Sessions are gone with the process (they are
  per-run), and the agent's next tool call recreates them.
- **Google blocked** — expected from datacenter IPs. Use SearXNG/Auto or
  Google Programmable Search, or complete the challenge by hand.

## 11. Stop everything

```bash
# Ctrl+C the DSH and browser-service processes
docker compose down
```

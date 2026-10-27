# Install dsh-browser

A complete first-run guide: clone the stack, start it, install the DSH panel,
and open a live browser.

## Requirements

- Node.js 24+
- Docker + Docker Compose
- Git
- DSH CLI:

```bash
npm install -g @deepseek-ai/dsh@latest
dsh --version
```

## 1. Clone and configure

```bash
git clone https://github.com/codeadeel/dsh-browser.git
cd dsh-browser
cp .env.example .env
```

The defaults are enough. `.env` configures the stack (gateway bind/port,
optional search/browser settings). It does not configure DSH.

## 2. Start the stack

```bash
docker compose up -d --build
docker compose ps
```

Expected: the gateway is the only published backend port:

```text
search-gateway: 127.0.0.1:8787->8787/tcp
browser:        8790-8791/tcp   (internal)
searxng:        8080/tcp        (internal)
brave-mcp:      8000/tcp        (internal)
```

Verify:

```bash
curl -s http://127.0.0.1:8787/health          # {"ok":true}
curl -s http://127.0.0.1:8787/browser/health  # {"ok":true,"sessions":0}
curl -s http://127.0.0.1:8787/viewer/health   # {"ok":true}

curl -s -X POST http://127.0.0.1:8787/search \
  -H 'content-type: application/json' \
  -d '{"query":"DeepSeek R2"}'
```

Search should return results through SearXNG. No API keys are required for
SearXNG or DuckDuckGo. `/search` is the endpoint used by the panel's native
ranked-search tool; `/test` is the same search lane used by the settings page.

## 3. Start DSH

```bash
dsh --profile web --no-open --host 127.0.0.1 --port 3000
```

Open the printed `?token=` URL.

On first run, add your model provider/API key. For a UI-only install you can
choose **Configure later**; the panel and browser still work without a model.

> DSH 0.2.1-rc.2 rejects `--host 0.0.0.0`. Use a concrete address. For remote
> access, use the host’s IP with `--public-url` and `--trusted-host`.

No `--patch` flag is needed.

## 4. Install the panel

In the DSH UI:

1. **Plugins**
2. **Add plugin**
3. Enter in the **package field**:
   ```text
   github:codeadeel/dsh-browser#path:panel
   ```
4. Leave **Registry** on the default npm registry
5. **Install**
6. Wait for **0.1.4**
7. **Enable now**

The panel registers the ranked search tool natively. There is no separate
MCP client, DSH patch, or `--patch` flag.

After enabling, the panel page should show:

```text
Components
1 total · 1 running

dsh-browser-panel       Running
```

### CLI alternative

```bash
dsh plugin --profile web add "github:codeadeel/dsh-browser#path:panel"
```

Then restart DSH.

For a local dev link, install the repo dependencies first:

```bash
pnpm install
dsh plugin --profile web add link:/path/to/dsh-browser/panel
```

## 5. Configure the gateway

Open **Plugins → dsh-browser-panel**.

Set **Stack gateway address** to exactly one URL:

- If the backend runs on the same host as DSH: `http://127.0.0.1:8787`
- If the backend runs elsewhere: its reachable gateway URL, for example
  `https://search.codeadeel.com`

Click **Save**. Expected:

```text
Saved · gateway reachable
```

This one setting drives the browser, viewer, and search. There are no DSH
gateway environment variables. The backend can be on a different host; the DSH
host only needs network access to this gateway URL.

Set your provider order and optional API keys on the same page, then run
**Test search**. Expected provider: `searxng` with results.

## 6. Use it

1. Click **Browser**.
2. Click **+** to create a browser session.
3. Enter a URL and press **Go**.
4. Or ask the agent:
   > Use the browser to search for the DeepSeek R2 release date, open the top result, and summarize it.

The agent gets native `browser_*` tools plus the ranked
`mcp__search__web_search` tool. You and the agent share the same page.

- Deleting a workspace closes its browser sessions.
- Idle browser sessions close after 30 minutes.
- Browser and viewer traffic goes through the DSH host proxy. The native search
  tool calls the gateway from the DSH server using the same plugin URL. Only
  the gateway port is published.

## 7. Remote DSH / Cloudflare Tunnel

Keep the stack gateway loopback-only:

```env
GATEWAY_BIND=127.0.0.1
GATEWAY_PORT=8787
```

Tunnel or reverse proxy:

```yaml
ingress:
  - hostname: search.codeadeel.com
    service: http://127.0.0.1:8787
  - service: http_status:404
```

If `cloudflared` runs as a compose container, target:

```text
http://search-gateway:8787
```

In the plugin UI, set the public URL:

```text
https://search.codeadeel.com
```

Only the gateway needs to be reachable by the DSH host. Users still open the
DSH UI, not the gateway.

For a direct private-network connection, set `GATEWAY_BIND` to the VPN/private
IP and enter that URL in the plugin UI. `0.0.0.0` is only appropriate behind a
firewall/VPN.

The gateway is unauthenticated. Do not expose it publicly without Cloudflare
Access/WAF/VPN or a gateway auth token.

## 8. Stop / clean

```bash
docker compose down
```

Full removal:

```bash
docker compose down -v --rmi all --remove-orphans
rm -rf data artifacts
```

DSH: stop the process. For a completely fresh DSH state, remove `~/.dsh` after
backing up anything you need.

## Troubleshooting

- **Registry URL error**: put the GitHub address in the package field, not
  Registry → Custom address.
- **No Browser button**: enable the panel; after a CLI install, restart DSH.
- **No search tool**: confirm the panel is installed and enabled. The native
  search tool is registered by the panel host when it loads.
- **Browser unreachable**: check `docker compose ps` and
  `http://127.0.0.1:8787/browser/health`.
- **Search fails**: check the gateway address in the plugin page; SearXNG needs
  no key.
- **`--host 0.0.0.0` rejected**: use a concrete IP.
- **Viewer connects but no frames**: a reverse proxy must pass SSE and
  WebSocket traffic without buffering.

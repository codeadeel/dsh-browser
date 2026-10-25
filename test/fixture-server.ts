import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface FixtureServer {
  url: string
  close: () => Promise<void>
}

export async function startFixtureServer(): Promise<FixtureServer> {
  const http = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')

    if (url.pathname === '/search') {
      const query =(url.searchParams.get('q') ?? '').trim()
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({
        query,
        results: [
          {
            title: 'Test Page',
            url: `${req.headers.host ? `http://${req.headers.host}` : 'http://127.0.0.1'}/page`,
            content: 'Deterministic fixture result for the hybrid search test.',
          },
        ],
      }))
      return
    }

    res.setHeader('content-type', 'text/html; charset=utf-8')

    if (url.pathname === '/set-cookie') {
      const name = url.searchParams.get('name') ?? 'fixture'
      const value = url.searchParams.get('value') ?? '1'
      res.setHeader('set-cookie', `${name}=${value}; Path=/; SameSite=Lax`)
      res.end(`<html><head><title>Cookie Set</title></head><body><h1>Cookie Set</h1><p>${name}=${value}</p></body></html>`)
      return
    }

    if (url.pathname === '/read-cookie') {
      res.end(`<html><head><title>Cookie Read</title></head><body><h1>Cookie Read</h1><pre>${req.headers.cookie ?? ''}</pre></body></html>`)
      return
    }

    if (url.pathname === '/next') {
      res.end('<html><head><title>Next Page</title></head><body><h1>Next Page</h1><p>second fixture page</p></body></html>')
      return
    }

    if (url.pathname === '/page') {
      res.end(`<!doctype html>
<html>
  <head><title>Test Page</title></head>
  <body>
    <h1>Test Page</h1>
    <p>fixture page for the dedicated browser</p>
    <a href="/next">Next</a>
    <label for="name">Name</label>
    <input id="name" name="name" placeholder="Your name">
    <button id="go" type="button">Go</button>
    <p id="out"></p>
    <script>
      console.log('fixture ready');
      document.getElementById('go').addEventListener('click', () => {
        document.getElementById('out').textContent = 'clicked';
      });
    </script>
  </body>
</html>`)
      return
    }

    res.end('<html><head><title>Fixture Home</title></head><body><h1>Fixture Home</h1><a href="/page">Page</a></body></html>')
  })

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject)
    http.listen(0, '127.0.0.1', () => resolve())
  })
  const address = http.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>(resolve => http.close(() => resolve()))
    },
  }
}

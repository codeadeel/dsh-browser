/** HTTP forwarding helpers for the DSH host proxy. */
export function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export function forward(req, res, target) {
  const controller = new AbortController()
  res.on('close', () => controller.abort())
  void (async () => {
    try {
      const init = {
        method: req.method,
        signal: controller.signal,
        headers: {},
      }
      if (req.headers['accept']) init.headers['accept'] = req.headers['accept']
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const body = await readBody(req)
        init.headers['content-type'] = req.headers['content-type'] || 'application/json'
        if (body.trim() !== '') init.body = body
      }
      const upstream = await fetch(target, init)
      const contentType = upstream.headers.get('content-type') || 'application/json'
      if (contentType.includes('text/event-stream')) {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
        })
        const reader = upstream.body.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          res.write(Buffer.from(value))
        }
        res.end()
        return
      }
      res.writeHead(upstream.status, { 'content-type': contentType, 'cache-control': 'no-store' })
      const text = await upstream.text()
      res.end(text)
    } catch (error) {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
      } else {
        res.destroy()
      }
    }
  })()
}

import { createServer } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { registerBrowserTools } from '../panel/tools.js'

const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nXQAAAAASUVORK5CYII='

let browser
let browserUrl

beforeAll(async () => {
  browser = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      ok: true,
      content: 'Screenshot saved',
      structured: { base64: PNG_1X1, mime: 'image/png', bytes: 68 },
    }))
  })
  await new Promise(resolve => browser.listen(0, '127.0.0.1', resolve))
  browserUrl = `http://127.0.0.1:${browser.address().port}`
})

afterAll(async () => {
  await new Promise(resolve => browser.close(resolve))
})

describe('panel browser screenshot', () => {
  it('returns a durable DSH image attachment instead of raw base64', async () => {
    const definitions = []
    const ctx = {
      get(name) {
        if (name === 'tools') {
          return { register: definition => { definitions.push(definition); return () => undefined } }
        }
        if (name === 'attachments') {
          return {
            saveImage: async ({ data, mediaType, name }) => ({
              attachmentId: 'attachment-test',
              mediaType,
              bytes: data.length,
              width: 1,
              height: 1,
              name,
            }),
          }
        }
        return undefined
      },
    }

    registerBrowserTools(ctx, browserUrl)
    const screenshot = definitions.find(definition => definition.name === 'browser_screenshot')
    expect(screenshot).toBeDefined()

    const result = await screenshot.execute({}, { agent: { session: { id: 'session-test' } } })
    expect(result.ok).toBe(true)
    expect(result.image).toMatchObject({ attachmentId: 'attachment-test', mediaType: 'image/png' })

    const rendered = screenshot.output.render({}, result)
    const image = rendered.find(block => block.type === 'image')
    expect(image).toEqual({
      type: 'image',
      attachment: {
        attachmentId: 'attachment-test',
        mediaType: 'image/png',
        bytes: 68,
        width: 1,
        height: 1,
        name: 'browser-session-test.png',
      },
    })
    expect(image).not.toHaveProperty('data')
  })
})

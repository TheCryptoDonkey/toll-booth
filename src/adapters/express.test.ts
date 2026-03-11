// src/adapters/express.test.ts
import { describe, it, expect, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import express from 'express'
import { createTollBooth } from '../core/toll-booth.js'
import { memoryStorage } from '../storage/memory.js'
import {
  createExpressMiddleware,
  createExpressCreateInvoiceHandler,
  createExpressInvoiceStatusHandler,
} from './express.js'
import type { LightningBackend } from '../types.js'

const ROOT_KEY = randomBytes(32).toString('hex')

function mockBackend(): LightningBackend {
  return {
    createInvoice: vi.fn().mockResolvedValue({
      bolt11: 'lnbc100n1mock...',
      paymentHash: 'b'.repeat(64),
    }),
    checkInvoice: vi.fn().mockResolvedValue({ paid: false }),
  }
}

async function request(app: express.Express, path: string, options: RequestInit = {}): Promise<Response> {
  const { createServer } = await import('node:http')
  return new Promise((resolve, reject) => {
    const server = createServer(app)
    server.listen(0, () => {
      const addr = server.address() as { port: number }
      fetch(`http://127.0.0.1:${addr.port}${path}`, options)
        .then(resolve)
        .catch(reject)
        .finally(() => server.close())
    })
  })
}

async function requestRaw(app: express.Express, requestText: string): Promise<string> {
  const { createServer } = await import('node:http')
  const { once } = await import('node:events')
  const { default: net } = await import('node:net')

  const server = createServer(app)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')

  try {
    const { port } = server.address() as { port: number }
    const socket = net.connect(port, '127.0.0.1')
    let response = ''

    socket.write(requestText)
    socket.on('data', (chunk: Buffer) => {
      response += chunk.toString('utf8')
    })
    await once(socket, 'end')
    return response
  } finally {
    server.close()
  }
}

describe('Express adapter', () => {
  it('returns 402 for priced routes without auth', async () => {
    const backend = mockBackend()
    const storage = memoryStorage()
    const engine = createTollBooth({
      backend,
      storage,
      pricing: { '/route': 10 },
      upstream: 'http://localhost:8002',
      rootKey: ROOT_KEY,
    })

    const app = express()
    app.use('/route', createExpressMiddleware(engine, 'http://localhost:8002'))

    const res = await request(app, '/route', { method: 'POST' })
    expect(res.status).toBe(402)
    expect(res.headers.get('cache-control')).toBe('no-store')

    const body = await res.json()
    expect(body).toHaveProperty('invoice')
    expect(body).toHaveProperty('macaroon')
    expect(body).toHaveProperty('payment_hash')
    expect(body).toHaveProperty('error', 'Payment required')
  })

  it('creates invoice via handler', async () => {
    const backend = mockBackend()
    const storage = memoryStorage()

    const app = express()
    app.use(express.json())
    app.post(
      '/create-invoice',
      createExpressCreateInvoiceHandler({
        backend,
        storage,
        rootKey: ROOT_KEY,
        tiers: [],
        defaultAmount: 1000,
      }),
    )

    const res = await request(app, '/create-invoice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')

    const body = await res.json()
    expect(body).toHaveProperty('bolt11')
    expect(body).toHaveProperty('payment_hash')
    expect(body).toHaveProperty('amount_sats', 1000)
  })

  it('requires the invoice status token for JSON status checks', async () => {
    const backend = mockBackend()
    const storage = memoryStorage()
    const paymentHash = 'b'.repeat(64)
    storage.storeInvoice(paymentHash, 'lnbc100n1mock...', 1000, 'mac_token', 'status-token')

    const app = express()
    app.get(
      '/invoice-status/:paymentHash',
      createExpressInvoiceStatusHandler({ backend, storage }),
    )

    const missingToken = await request(app, `/invoice-status/${paymentHash}`, {
      headers: { Accept: 'application/json' },
    })
    expect(missingToken.status).toBe(404)

    const ok = await request(app, `/invoice-status/${paymentHash}?token=status-token`, {
      headers: { Accept: 'application/json' },
    })
    expect(ok.status).toBe(200)
    expect(ok.headers.get('cache-control')).toBe('no-store')
    expect(ok.headers.get('vary')).toBe('Accept')
    expect(await ok.json()).toEqual({ paid: false })
  })

  it('forwards parsed POST body to upstream when express.json() is mounted', async () => {
    const { createServer } = await import('node:http')

    // Upstream echo server — returns the received body
    const upstream = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(Buffer.concat(chunks))
      })
    })
    await new Promise<void>((r) => upstream.listen(0, r))
    const upstreamPort = (upstream.address() as { port: number }).port

    const backend = mockBackend()
    const storage = memoryStorage()
    const engine = createTollBooth({
      backend,
      storage,
      pricing: {},  // no priced routes — everything passes through
      upstream: `http://127.0.0.1:${upstreamPort}`,
      rootKey: ROOT_KEY,
    })

    const app = express()
    app.use(express.json())  // body parser before middleware
    app.use('/api', createExpressMiddleware(engine, `http://127.0.0.1:${upstreamPort}`))

    try {
      const payload = { hello: 'world' }
      const res = await request(app, '/api/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual(payload)
    } finally {
      upstream.close()
    }
  })

  it('does not allow absolute-form request targets to override the configured upstream host', async () => {
    const backend = mockBackend()
    const storage = memoryStorage()
    const engine = createTollBooth({
      backend,
      storage,
      pricing: {},
      upstream: 'http://127.0.0.1:8002',
      rootKey: ROOT_KEY,
    })

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('ok', { status: 200 }),
    )

    const app = express()
    app.use(createExpressMiddleware(engine, 'http://127.0.0.1:8002'))

    try {
      await requestRaw(
        app,
        'GET http://evil.test/pwn?x=1 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n',
      )

      expect(fetchSpy).toHaveBeenCalledWith(
        'http://127.0.0.1:8002/pwn?x=1',
        expect.any(Object),
      )
    } finally {
      fetchSpy.mockRestore()
    }
  })
})

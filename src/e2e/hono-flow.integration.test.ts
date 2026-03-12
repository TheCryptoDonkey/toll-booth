// src/e2e/hono-flow.integration.test.ts
//
// End-to-end tests for the Hono adapter with real HTTP round-trips.
// Uses in-memory storage and a mock backend; no external services required.
//
import { describe, it, expect, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { createHonoTollBooth, type TollBoothEnv } from '../adapters/hono.js'
import { createTollBooth } from '../core/toll-booth.js'
import { memoryStorage } from '../storage/memory.js'
import type { LightningBackend } from '../types.js'

const ROOT_KEY = randomBytes(32).toString('hex')

function mockBackend(): LightningBackend {
  return {
    createInvoice: vi.fn().mockResolvedValue({ bolt11: 'lnbc1mock', paymentHash: randomBytes(32).toString('hex') }),
    checkInvoice: vi.fn().mockResolvedValue({ paid: false }),
  }
}

describe('Hono adapter E2E with HTTP round-trip', () => {
  it('full L402 flow through real HTTP server', async () => {
    const storage = memoryStorage()
    const engine = createTollBooth({
      backend: mockBackend(),
      storage,
      pricing: { '/api/data': 10 },
      upstream: 'http://upstream.test',
      rootKey: ROOT_KEY,
      defaultInvoiceAmount: 1000,
    })

    const tollBooth = createHonoTollBooth({ engine })
    const app = new Hono<TollBoothEnv>()

    // Mount payment routes
    app.route('/', tollBooth.createPaymentApp({
      storage,
      rootKey: ROOT_KEY,
      tiers: [],
      defaultAmount: 1000,
    }))

    // Auth middleware + handler
    app.use('/api/*', tollBooth.authMiddleware)
    app.get('/api/data', (c) => {
      return c.json({
        action: c.get('tollBoothAction'),
        balance: c.get('tollBoothCreditBalance'),
      })
    })

    // Start real HTTP server
    const server = serve({ fetch: app.fetch, port: 0 })
    const addr = server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    const base = `http://127.0.0.1:${port}`

    try {
      // Step 1: Unauthenticated request -> 402
      const challengeRes = await fetch(`${base}/api/data`)
      expect(challengeRes.status).toBe(402)
      const challenge = await challengeRes.json() as Record<string, unknown>
      expect(challenge).toHaveProperty('payment_hash')
      expect(challenge).toHaveProperty('macaroon')
      expect(challengeRes.headers.get('www-authenticate')).toMatch(/^L402 macaroon="/)

      // Step 2: Create invoice via payment route
      const createRes = await fetch(`${base}/create-invoice`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(createRes.status).toBe(200)
      const invoice = await createRes.json() as Record<string, unknown>
      const paymentHash = invoice.payment_hash as string
      const macaroon = invoice.macaroon as string
      expect(paymentHash).toMatch(/^[0-9a-f]{64}$/)

      // Step 3: Check invoice status (unpaid)
      const statusRes = await fetch(`${base}${invoice.payment_url}`)
      expect(statusRes.status).toBe(200)
      const status = await statusRes.json() as Record<string, unknown>
      expect(status.paid).toBe(false)

      // Step 4: Settle payment (simulate Lightning payment)
      const preimage = randomBytes(32).toString('hex')
      storage.settleWithCredit(paymentHash, 1000, preimage)

      // Step 5: Authenticated request
      const authRes = await fetch(`${base}/api/data`, {
        headers: { Authorization: `L402 ${macaroon}:${preimage}` },
      })
      expect(authRes.status).toBe(200)
      const body = await authRes.json() as Record<string, unknown>
      expect(body.action).toBe('proxy')
      expect(typeof body.balance).toBe('number')
    } finally {
      server.close()
    }
  })

  it('free-tier requests pass through HTTP round-trip', async () => {
    const storage = memoryStorage()
    const engine = createTollBooth({
      backend: mockBackend(),
      storage,
      pricing: { '/api/data': 10 },
      upstream: 'http://upstream.test',
      rootKey: ROOT_KEY,
      defaultInvoiceAmount: 1000,
      freeTier: { requestsPerDay: 3 },
    })

    const tollBooth = createHonoTollBooth({
      engine,
      getClientIp: () => '10.0.0.1',
    })
    const app = new Hono<TollBoothEnv>()
    app.use('/api/*', tollBooth.authMiddleware)
    app.get('/api/data', (c) => c.json({ action: c.get('tollBoothAction') }))

    const server = serve({ fetch: app.fetch, port: 0 })
    const addr = server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    const base = `http://127.0.0.1:${port}`

    try {
      // First 3 requests should pass (free tier)
      for (let i = 0; i < 3; i++) {
        const res = await fetch(`${base}/api/data`)
        expect(res.status).toBe(200)
        const body = await res.json() as Record<string, unknown>
        expect(body.action).toBe('proxy')
      }

      // 4th request should get 402
      const res = await fetch(`${base}/api/data`)
      expect(res.status).toBe(402)
    } finally {
      server.close()
    }
  })

  it('invoice status returns HTML payment page', async () => {
    const storage = memoryStorage()
    const engine = createTollBooth({
      backend: mockBackend(),
      storage,
      pricing: {},
      upstream: 'http://upstream.test',
      rootKey: ROOT_KEY,
      defaultInvoiceAmount: 1000,
    })

    const tollBooth = createHonoTollBooth({ engine })
    const app = new Hono()
    app.route('/', tollBooth.createPaymentApp({
      storage,
      rootKey: ROOT_KEY,
      tiers: [],
      defaultAmount: 1000,
    }))

    const server = serve({ fetch: app.fetch, port: 0 })
    const addr = server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    const base = `http://127.0.0.1:${port}`

    try {
      // Create invoice
      const createRes = await fetch(`${base}/create-invoice`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const invoice = await createRes.json() as Record<string, unknown>

      // Request HTML payment page
      const htmlRes = await fetch(`${base}${invoice.payment_url}`, {
        headers: { Accept: 'text/html' },
      })
      expect(htmlRes.status).toBe(200)
      expect(htmlRes.headers.get('content-type')).toContain('text/html')
      const html = await htmlRes.text()
      expect(html).toContain('Payment Required')
      expect(html).toContain('toll-booth')
    } finally {
      server.close()
    }
  })
})

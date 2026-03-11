// src/adapters/hono.test.ts
import { describe, it, expect, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import { Hono } from 'hono'
import { createTollBooth } from '../core/toll-booth.js'
import { memoryStorage } from '../storage/memory.js'
import { createHonoMiddleware, createHonoInvoiceStatusHandler, createHonoCreateInvoiceHandler } from './hono.js'
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

describe('Hono adapter IP resolution', () => {
  it('uses getClientIp callback when provided', async () => {
    const backend = mockBackend()
    const storage = memoryStorage()
    const engine = createTollBooth({
      backend,
      storage,
      pricing: { '/route': 10 },
      upstream: 'http://localhost:8002',
      rootKey: ROOT_KEY,
      freeTier: { requestsPerDay: 2 },
    })

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('ok', { status: 200 }),
    )

    try {
      const app = new Hono()
      app.use('/route', createHonoMiddleware({
        engine,
        upstream: 'http://upstream.test',
        getClientIp: () => '1.2.3.4',
      }))

      const res1 = await app.request('/route', { method: 'POST' })
      expect(res1.status).toBe(200)

      const res2 = await app.request('/route', { method: 'POST' })
      expect(res2.status).toBe(200)

      const res3 = await app.request('/route', { method: 'POST' })
      expect(res3.status).toBe(402)
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('throws when freeTier enabled without trustProxy or getClientIp', () => {
    const backend = mockBackend()
    const storage = memoryStorage()
    const engine = createTollBooth({
      backend,
      storage,
      pricing: { '/route': 10 },
      upstream: 'http://localhost:8002',
      rootKey: ROOT_KEY,
      freeTier: { requestsPerDay: 5 },
    })

    expect(() => createHonoMiddleware({
      engine,
      upstream: 'http://localhost:8002',
    })).toThrow(/freeTier requires either trustProxy: true or getClientIp/)
  })
})

describe('Hono adapter', () => {
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

    const app = new Hono()
    app.use('/route', createHonoMiddleware({ engine, upstream: 'http://localhost:8002' }))

    const res = await app.request('/route', { method: 'POST' })
    expect(res.status).toBe(402)

    const body = await res.json()
    expect(body).toHaveProperty('invoice')
    expect(body).toHaveProperty('macaroon')
    expect(body).toHaveProperty('payment_hash')
    expect(body).toHaveProperty('error', 'Payment required')
  })

  it('returns JSON for invoice status', async () => {
    const backend = mockBackend()
    const storage = memoryStorage()
    const paymentHash = 'b'.repeat(64)
    storage.storeInvoice(paymentHash, 'lnbc100n1mock...', 1000, 'mac_token')

    const app = new Hono()
    app.get(
      '/invoice-status/:paymentHash',
      createHonoInvoiceStatusHandler({ backend, storage }),
    )

    const res = await app.request(`/invoice-status/${paymentHash}`, {
      headers: { Accept: 'application/json' },
    })
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body).toHaveProperty('paid', false)
  })

  it('creates invoice via handler', async () => {
    const backend = mockBackend()
    const storage = memoryStorage()

    const app = new Hono()
    app.post(
      '/create-invoice',
      createHonoCreateInvoiceHandler({
        backend,
        storage,
        rootKey: ROOT_KEY,
        tiers: [],
        defaultAmount: 1000,
      }),
    )

    const res = await app.request('/create-invoice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body).toHaveProperty('bolt11')
    expect(body).toHaveProperty('payment_hash')
    expect(body).toHaveProperty('amount_sats', 1000)
  })
})

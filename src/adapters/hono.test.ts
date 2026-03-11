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

    const app = new Hono()
    app.use('/route', createHonoMiddleware({
      engine,
      upstream: 'http://localhost:8002',
      getClientIp: () => '1.2.3.4',
    }))

    // First request should pass (free tier)
    const res1 = await app.request('/route', { method: 'POST' })
    // Engine proxies upstream, which isn't running, so expect a non-402 error
    expect(res1.status).not.toBe(402)

    // Second request for same IP
    const res2 = await app.request('/route', { method: 'POST' })
    expect(res2.status).not.toBe(402)

    // Third request should be challenged (free tier exhausted for 1.2.3.4)
    const res3 = await app.request('/route', { method: 'POST' })
    expect(res3.status).toBe(402)
  })

  it('warns when freeTier enabled without trustProxy or getClientIp', () => {
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

    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    createHonoMiddleware({ engine, upstream: 'http://localhost:8002' })
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('freeTier is enabled'))
    spy.mockRestore()
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

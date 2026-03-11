// src/adapters/web-standard.test.ts
import { describe, it, expect, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import { createTollBooth } from '../core/toll-booth.js'
import { memoryStorage } from '../storage/memory.js'
import {
  createWebStandardMiddleware,
  createWebStandardCreateInvoiceHandler,
  createWebStandardInvoiceStatusHandler,
} from './web-standard.js'
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

describe('Web Standard adapter IP resolution', () => {
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
      const handler = createWebStandardMiddleware({
        engine,
        upstream: 'http://upstream.test',
        getClientIp: () => '1.2.3.4',
      })

      const makeRequest = () => new Request('http://localhost/route', { method: 'POST' })

      const res1 = await handler(makeRequest())
      expect(res1.status).toBe(200)

      const res2 = await handler(makeRequest())
      expect(res2.status).toBe(200)

      const res3 = await handler(makeRequest())
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

    expect(() => createWebStandardMiddleware({
      engine,
      upstream: 'http://localhost:8002',
    })).toThrow(/freeTier requires either trustProxy: true or getClientIp/)
  })
})

describe('Web Standard adapter', () => {
  it('returns 402 for priced routes without auth', async () => {
    const backend = mockBackend()
    const storage = memoryStorage()
    const engine = createTollBooth({
      backend,
      storage,
      pricing: { '/api/route': 10 },
      upstream: 'http://localhost:8002',
      rootKey: ROOT_KEY,
    })

    const handler = createWebStandardMiddleware(engine, 'http://localhost:8002')
    const res = await handler(new Request('http://localhost/api/route', { method: 'POST' }))

    expect(res.status).toBe(402)

    const body = await res.json()
    expect(body).toHaveProperty('invoice')
    expect(body).toHaveProperty('macaroon')
    expect(body).toHaveProperty('payment_hash')
    expect(body).toHaveProperty('error', 'Payment required')
  })

  it('creates invoice via handler', async () => {
    const backend = mockBackend()
    const storage = memoryStorage()

    const handler = createWebStandardCreateInvoiceHandler({
      backend,
      storage,
      rootKey: ROOT_KEY,
      tiers: [],
      defaultAmount: 1000,
    })

    const res = await handler(
      new Request('http://localhost/create-invoice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }),
    )

    expect(res.status).toBe(200)

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

    const handler = createWebStandardInvoiceStatusHandler({ backend, storage })

    const missingToken = await handler(
      new Request(`http://localhost/invoice-status/${paymentHash}`, {
        headers: { Accept: 'application/json' },
      }),
    )
    expect(missingToken.status).toBe(404)

    const ok = await handler(
      new Request(`http://localhost/invoice-status/${paymentHash}?token=status-token`, {
        headers: { Accept: 'application/json' },
      }),
    )
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ paid: false })
  })
})

// src/middleware.test.ts
import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import { lightningGate } from './middleware.js'
import type { LightningBackend } from './types.js'

function mockBackend(): LightningBackend {
  return {
    createInvoice: vi.fn().mockResolvedValue({
      bolt11: 'lnbc100n1mock...',
      paymentHash: 'b'.repeat(64),
    }),
    checkInvoice: vi.fn().mockResolvedValue({ paid: true, preimage: 'c'.repeat(64) }),
  }
}

function createApp(backend: LightningBackend, overrides?: Record<string, unknown>) {
  const app = new Hono()
  const gate = lightningGate({
    backend,
    pricing: { '/route': 2, '/isochrone': 5 },
    upstream: 'http://localhost:8002',
    freeTier: { requestsPerDay: 3 },
    rootKey: 'a'.repeat(64),
    dbPath: ':memory:',
    ...overrides,
  })
  app.use('/*', gate)
  return app
}

describe('lightningGate middleware', () => {
  describe('free tier', () => {
    it('serves requests within free tier limit', async () => {
      const app = createApp(mockBackend())
      const res = await app.request('/route', { method: 'POST' })
      // The upstream is not reachable in tests, but the middleware should attempt to proxy.
      // We confirm it did not return 402.
      expect(res.status).not.toBe(402)
    })

    it('returns 402 when free tier is exhausted', async () => {
      const app = createApp(mockBackend())
      // Exhaust free tier
      for (let i = 0; i < 3; i++) {
        await app.request('/route', {
          method: 'POST',
          headers: { 'X-Forwarded-For': '1.2.3.4' },
        })
      }
      const res = await app.request('/route', {
        method: 'POST',
        headers: { 'X-Forwarded-For': '1.2.3.4' },
      })
      expect(res.status).toBe(402)
      expect(res.headers.get('WWW-Authenticate')).toMatch(/^L402 /)
    })
  })

  describe('L402 authentication', () => {
    it('returns 402 with macaroon and invoice when no free tier configured', async () => {
      // Omit freeTier entirely so every request goes straight to L402 challenge.
      const backend = mockBackend()
      const app = createApp(backend, { freeTier: undefined })

      const res = await app.request('/route', { method: 'POST' })
      expect(res.status).toBe(402)

      const wwwAuth = res.headers.get('WWW-Authenticate')!
      expect(wwwAuth).toMatch(/^L402 macaroon="[^"]+", invoice="lnbc/)
    })

    it('rejects invalid Authorization header', async () => {
      const app = createApp(mockBackend(), { freeTier: undefined })
      const res = await app.request('/route', {
        method: 'POST',
        headers: { 'Authorization': 'L402 garbage' },
      })
      expect(res.status).toBe(402)
    })
  })

  describe('coverage header', () => {
    it('includes X-Coverage header on all responses', async () => {
      const app = createApp(mockBackend())
      const res = await app.request('/route', { method: 'POST' })
      // Even free-tier responses should carry the coverage header.
      expect(res.headers.get('X-Coverage')).toBeTruthy()
    })
  })
})

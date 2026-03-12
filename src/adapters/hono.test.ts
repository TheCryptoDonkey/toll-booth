// src/adapters/hono.test.ts
import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import { createHash, randomBytes } from 'node:crypto'
import { createHonoTollBooth, type TollBoothEnv } from './hono.js'
import { memoryStorage } from '../storage/memory.js'
import { createTollBooth } from '../core/toll-booth.js'
import { mintMacaroon } from '../macaroon.js'

// -- Helpers ------------------------------------------------------------------

function makeCredential(rootKey: string, creditSats = 1000) {
  const preimage = randomBytes(32).toString('hex')
  const paymentHash = createHash('sha256')
    .update(Buffer.from(preimage, 'hex'))
    .digest('hex')
  const macaroon = mintMacaroon(rootKey, paymentHash, creditSats)
  return { preimage, paymentHash, macaroon }
}

function createTestEngine(overrides?: Partial<Parameters<typeof createTollBooth>[0]>) {
  const rootKey = 'a'.repeat(64)
  const storage = memoryStorage()
  const engine = createTollBooth({
    rootKey,
    storage,
    upstream: 'http://upstream.test',
    pricing: { '/api/test': 10 },
    defaultInvoiceAmount: 1000,
    ...overrides,
  })
  return { engine, storage, rootKey }
}

// -- Tests --------------------------------------------------------------------

describe('createHonoTollBooth', () => {
  it('passes through authenticated request and sets context variables', async () => {
    const { engine, storage, rootKey } = createTestEngine()
    const { authMiddleware } = createHonoTollBooth({ engine })

    const { preimage, paymentHash, macaroon } = makeCredential(rootKey, 1000)
    // Settle the invoice so the credential is valid
    storage.settleWithCredit(paymentHash, 1000, preimage)

    const app = new Hono<TollBoothEnv>()
    app.use('/api/test', authMiddleware)
    app.get('/api/test', (c) => {
      return c.json({
        action: c.get('tollBoothAction'),
        paymentHash: c.get('tollBoothPaymentHash'),
        creditBalance: c.get('tollBoothCreditBalance'),
      })
    })

    const res = await app.request('/api/test', {
      headers: { Authorization: `L402 ${macaroon}:${preimage}` },
    })

    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.action).toBe('proxy')
    expect(body.paymentHash).toBe(paymentHash)
    expect(typeof body.creditBalance).toBe('number')
  })

  it('returns 402 challenge when no auth header is present', async () => {
    const { engine } = createTestEngine()
    const { authMiddleware } = createHonoTollBooth({ engine })

    const app = new Hono<TollBoothEnv>()
    app.use('/api/test', authMiddleware)
    app.get('/api/test', (c) => c.text('ok'))

    const res = await app.request('/api/test')

    expect(res.status).toBe(402)
    const body = await res.json() as Record<string, unknown>
    expect(body).toHaveProperty('payment_hash')
    expect(body).toHaveProperty('macaroon')
    expect(body.error).toBe('Payment required')
    expect(res.headers.get('www-authenticate')).toMatch(/^L402 macaroon="/)
  })

  it('passes through free-tier request and sets action to proxy', async () => {
    const { engine } = createTestEngine({
      freeTier: { requestsPerDay: 5 },
    })
    const { authMiddleware } = createHonoTollBooth({ engine })

    const app = new Hono<TollBoothEnv>()
    app.use('/api/test', authMiddleware)
    app.get('/api/test', (c) => {
      return c.json({ action: c.get('tollBoothAction') })
    })

    const res = await app.request('/api/test', {
      headers: { 'x-forwarded-for': '10.0.0.1' },
    })

    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.action).toBe('proxy')
  })

  it('passes through unpriced route without auth (action = pass)', async () => {
    const { engine } = createTestEngine()
    const { authMiddleware } = createHonoTollBooth({ engine })

    const app = new Hono<TollBoothEnv>()
    app.use('/health', authMiddleware)
    app.get('/health', (c) => {
      return c.json({ action: c.get('tollBoothAction') })
    })

    const res = await app.request('/health')

    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.action).toBe('pass')
  })

  it('invokes custom getClientIp callback for IP resolution', async () => {
    const { engine } = createTestEngine()
    const getClientIp = vi.fn().mockReturnValue('5.6.7.8')
    const { authMiddleware } = createHonoTollBooth({ engine, getClientIp })

    const app = new Hono<TollBoothEnv>()
    app.use('/api/test', authMiddleware)
    app.get('/api/test', (c) => c.text('ok'))

    // The request will issue a 402 (no auth) but getClientIp should be called
    await app.request('/api/test')

    expect(getClientIp).toHaveBeenCalledOnce()
  })

  it('returns 402 for invalid L402 credentials', async () => {
    const { engine } = createTestEngine()
    const { authMiddleware } = createHonoTollBooth({ engine })

    const app = new Hono<TollBoothEnv>()
    app.use('/api/test', authMiddleware)
    app.get('/api/test', (c) => c.text('ok'))

    const res = await app.request('/api/test', {
      headers: { Authorization: 'L402 invalid:credentials' },
    })

    expect(res.status).toBe(402)
    const body = await res.json() as Record<string, unknown>
    expect(body.error).toBe('Payment required')
  })
})

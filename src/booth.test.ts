// src/booth.test.ts
import { describe, it, expect, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { Hono } from 'hono'
import { Booth } from './booth.js'
import { memoryStorage } from './storage/memory.js'
import type { LightningBackend, CreditTier } from './types.js'

const ROOT_KEY = 'a'.repeat(64)

function makePreimageAndHash(): { preimage: string; paymentHash: string } {
  const preimage = 'deadbeef'.repeat(8)
  const paymentHash = createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex')
  return { preimage, paymentHash }
}

const TIERS: CreditTier[] = [
  { amountSats: 1000, creditSats: 1000, label: 'Starter' },
  { amountSats: 10_000, creditSats: 11_100, label: 'Pro' },
]

function setup(overrides?: Partial<{
  nwcPayInvoice: any
  redeemCashu: any
  trustProxy: boolean
  adminToken: string
}>) {
  const { preimage, paymentHash } = makePreimageAndHash()

  const backend: LightningBackend = {
    createInvoice: vi.fn().mockResolvedValue({
      bolt11: 'lnbc1000n1test...',
      paymentHash,
    }),
    checkInvoice: vi.fn().mockResolvedValue({ paid: false }),
  }

  const booth = new Booth({
    adapter: 'hono',
    backend,
    pricing: { '/route': 2 },
    upstream: 'http://localhost:8002',
    rootKey: ROOT_KEY,
    storage: memoryStorage(),
    creditTiers: TIERS,
    ...overrides,
  })

  const app = new Hono()
  app.get('/invoice-status/:paymentHash', booth.invoiceStatusHandler as any)
  app.post('/create-invoice', booth.createInvoiceHandler as any)
  if (booth.nwcPayHandler) app.post('/nwc-pay', booth.nwcPayHandler as any)
  if (booth.cashuRedeemHandler) app.post('/cashu-redeem', booth.cashuRedeemHandler as any)
  app.use('/*', booth.middleware as any)

  return { app, booth, backend, preimage, paymentHash }
}

describe('Booth', () => {
  describe('rootKey validation', () => {
    it('rejects a short rootKey', () => {
      expect(() => new Booth({
        backend: { createInvoice: vi.fn(), checkInvoice: vi.fn() },
        pricing: {},
        upstream: 'http://localhost',
        rootKey: 'abc',
        dbPath: ':memory:',
      })).toThrow(/64 hex characters/)
    })

    it('accepts a valid 64-char hex rootKey', () => {
      const booth = new Booth({
        backend: { createInvoice: vi.fn(), checkInvoice: vi.fn() },
        pricing: {},
        upstream: 'http://localhost',
        rootKey: 'a'.repeat(64),
        dbPath: ':memory:',
      })
      booth.close()
    })
  })

  describe('paymentHash validation', () => {
    it('rejects non-hex payment hash', async () => {
      const { app, booth } = setup()
      const res = await app.request('/invoice-status/not-a-valid-hash')
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toContain('64 hex')
      booth.close()
    })

    it('rejects a short payment hash', async () => {
      const { app, booth } = setup()
      const res = await app.request('/invoice-status/abc123')
      expect(res.status).toBe(400)
      booth.close()
    })
  })

  it('issues 402 with payment_url and stores invoice', async () => {
    const { app, booth, paymentHash } = setup()

    const res = await app.request('/route', { method: 'POST' })
    expect(res.status).toBe(402)

    const body = await res.json()
    expect(body.payment_url).toBe(`/invoice-status/${paymentHash}`)
    expect(body.payment_hash).toBe(paymentHash)

    booth.close()
  })

  it('serves HTML payment page at /invoice-status/:paymentHash', async () => {
    const { app, booth, paymentHash } = setup()

    // First trigger a 402 to store the invoice
    await app.request('/route', { method: 'POST' })

    // Now request the payment page
    const res = await app.request(`/invoice-status/${paymentHash}`, {
      headers: { 'Accept': 'text/html' },
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('text/html')
    const html = await res.text()
    expect(html).toContain('Payment Required')
    expect(html).toContain('lnbc1000n1test...')
    expect(html).toContain('Starter')
    expect(html).toContain('Pro')

    booth.close()
  })

  it('serves JSON invoice status at /invoice-status/:paymentHash', async () => {
    const { app, booth, backend, paymentHash } = setup()
    vi.mocked(backend.checkInvoice).mockResolvedValue({ paid: false })

    const res = await app.request(`/invoice-status/${paymentHash}`, {
      headers: { 'Accept': 'application/json' },
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ paid: false })

    booth.close()
  })

  it('creates invoice via POST /create-invoice', async () => {
    const { app, booth, paymentHash } = setup()

    const res = await app.request('/create-invoice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amountSats: 10_000 }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.amount_sats).toBe(10_000)
    expect(body.credit_sats).toBe(11_100) // Pro tier

    booth.close()
  })

  it('rejects invalid tier in POST /create-invoice', async () => {
    const { app, booth } = setup()

    const res = await app.request('/create-invoice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amountSats: 5000 }),
    })

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('Invalid amount')

    booth.close()
  })

  describe('NWC adapter', () => {
    it('pays via NWC and credits the server-determined amount', async () => {
      const { preimage, paymentHash } = makePreimageAndHash()
      const nwcPayInvoice = vi.fn().mockResolvedValue(preimage)
      const { app, booth } = setup({ nwcPayInvoice })

      // First trigger a 402 to store the invoice (amount = defaultInvoiceAmount = 1000)
      await app.request('/route', { method: 'POST' })

      const res = await app.request('/nwc-pay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nwcUri: 'nostr+walletconnect://...', bolt11: 'lnbc1000n1test...',
          paymentHash,
        }),
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.preimage).toBe(preimage)
      // Credits the amount from the stored invoice (defaultInvoiceAmount), not client-supplied
      expect(body.credited).toBe(1000)
      expect(nwcPayInvoice).toHaveBeenCalledWith('nostr+walletconnect://...', 'lnbc1000n1test...')

      booth.close()
    })

    it('rejects NWC payment for unknown payment hash', async () => {
      const nwcPayInvoice = vi.fn()
      const { app, booth } = setup({ nwcPayInvoice })

      const res = await app.request('/nwc-pay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nwcUri: 'nostr+walletconnect://...', bolt11: 'lnbc...',
          paymentHash: 'e'.repeat(64),
        }),
      })

      expect(res.status).toBe(404)
      expect(nwcPayInvoice).not.toHaveBeenCalled()

      booth.close()
    })

    it('rejects replay of same payment hash', async () => {
      const { preimage, paymentHash } = makePreimageAndHash()
      const nwcPayInvoice = vi.fn().mockResolvedValue(preimage)
      const { app, booth } = setup({ nwcPayInvoice })

      // Store invoice
      await app.request('/route', { method: 'POST' })

      // First payment succeeds
      await app.request('/nwc-pay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nwcUri: 'nostr+walletconnect://...', bolt11: 'lnbc1000n1test...',
          paymentHash,
        }),
      })

      // Second with same hash is rejected before calling NWC
      nwcPayInvoice.mockClear()
      const res2 = await app.request('/nwc-pay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nwcUri: 'nostr+walletconnect://...', bolt11: 'lnbc1000n1test...',
          paymentHash,
        }),
      })

      expect(res2.status).toBe(409)
      expect(nwcPayInvoice).not.toHaveBeenCalled()

      booth.close()
    })

    it('rejects NWC payment when preimage does not match hash', async () => {
      const { paymentHash } = makePreimageAndHash()
      const nwcPayInvoice = vi.fn().mockResolvedValue('aa'.repeat(32)) // wrong preimage
      const { app, booth } = setup({ nwcPayInvoice })

      // Store invoice
      await app.request('/route', { method: 'POST' })

      const res = await app.request('/nwc-pay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nwcUri: 'nostr+walletconnect://...', bolt11: 'lnbc1000n1test...',
          paymentHash,
        }),
      })

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toContain('Preimage does not match')

      booth.close()
    })

    it('does not expose /nwc-pay when adapter not provided', async () => {
      const { booth } = setup()
      expect(booth.nwcPayHandler).toBeUndefined()
      booth.close()
    })
  })

  describe('Cashu adapter', () => {
    it('redeems Cashu token and credits meter', async () => {
      const redeemCashu = vi.fn().mockResolvedValue(500)
      const { app, booth, paymentHash } = setup({ redeemCashu })

      // Trigger a 402 to store the invoice for this paymentHash
      await app.request('/route', { method: 'POST' })

      const res = await app.request('/cashu-redeem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'cashuA...', paymentHash }),
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.credited).toBe(500)
      expect(redeemCashu).toHaveBeenCalledWith('cashuA...', paymentHash)

      booth.close()
    })

    it('rejects replay of same payment hash', async () => {
      const redeemCashu = vi.fn().mockResolvedValue(500)
      const { app, booth, paymentHash } = setup({ redeemCashu })

      // Store invoice
      await app.request('/route', { method: 'POST' })

      // First redeem succeeds
      const res1 = await app.request('/cashu-redeem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'cashuA...', paymentHash }),
      })
      expect(res1.status).toBe(200)

      // Second redeem with same hash is rejected
      const res2 = await app.request('/cashu-redeem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'cashuA...', paymentHash }),
      })
      expect(res2.status).toBe(409)
      const body = await res2.json()
      expect(body.error).toContain('already been credited')

      booth.close()
    })

    it('rejects unknown payment hash', async () => {
      const redeemCashu = vi.fn()
      const { app, booth } = setup({ redeemCashu })

      const res = await app.request('/cashu-redeem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'cashuA...', paymentHash: 'e'.repeat(64) }),
      })
      expect(res.status).toBe(404)
      expect(redeemCashu).not.toHaveBeenCalled()

      booth.close()
    })

    it('rejects invalid paymentHash format', async () => {
      const redeemCashu = vi.fn().mockResolvedValue(500)
      const { app, booth } = setup({ redeemCashu })

      const res = await app.request('/cashu-redeem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'cashuA...', paymentHash: 'not-valid' }),
      })
      expect(res.status).toBe(400)
      expect(redeemCashu).not.toHaveBeenCalled()

      booth.close()
    })

    it('does not expose /cashu-redeem when adapter not provided', async () => {
      const { booth } = setup()
      expect(booth.cashuRedeemHandler).toBeUndefined()
      booth.close()
    })

    it('cross-instance: only one instance calls redeem() for the same hash', async () => {
      const { preimage, paymentHash } = makePreimageAndHash()
      const tmpDb = `/tmp/toll-booth-race-${Date.now()}.db`

      // Two independent Booth instances sharing the same SQLite DB
      const redeemA = vi.fn().mockImplementation(
        () => new Promise<number>((resolve) => setTimeout(() => resolve(500), 50)),
      )
      const redeemB = vi.fn().mockImplementation(
        () => new Promise<number>((resolve) => setTimeout(() => resolve(500), 50)),
      )

      const backend: LightningBackend = {
        createInvoice: vi.fn().mockResolvedValue({ bolt11: 'lnbc1000n1test...', paymentHash }),
        checkInvoice: vi.fn().mockResolvedValue({ paid: false }),
      }

      const boothA = new Booth({
        backend, pricing: { '/route': 2 }, upstream: 'http://localhost:8002',
        rootKey: ROOT_KEY, dbPath: tmpDb, redeemCashu: redeemA,
      })
      const boothB = new Booth({
        backend, pricing: { '/route': 2 }, upstream: 'http://localhost:8002',
        rootKey: ROOT_KEY, dbPath: tmpDb, redeemCashu: redeemB,
      })

      const appA = new Hono()
      appA.post('/cashu-redeem', boothA.cashuRedeemHandler!)
      appA.use('/*', boothA.middleware)

      const appB = new Hono()
      appB.post('/cashu-redeem', boothB.cashuRedeemHandler!)
      appB.use('/*', boothB.middleware)

      // Store invoice via instance A (both share the same DB)
      await appA.request('/route', { method: 'POST' })

      // Race: both instances attempt redeem concurrently
      const [resA, resB] = await Promise.all([
        appA.request('/cashu-redeem', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: 'cashuA...', paymentHash }),
        }),
        appB.request('/cashu-redeem', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: 'cashuB...', paymentHash }),
        }),
      ])

      const statuses = [resA.status, resB.status].sort()
      expect(statuses).toEqual([200, 409])

      // Critical: only ONE instance should have called its redeem adapter
      const totalRedeemCalls = redeemA.mock.calls.length + redeemB.mock.calls.length
      expect(totalRedeemCalls).toBe(1)

      boothA.close()
      boothB.close()

      // Clean up temp DB
      const { unlinkSync } = await import('node:fs')
      try { unlinkSync(tmpDb) } catch {}
      try { unlinkSync(`${tmpDb}-wal`) } catch {}
      try { unlinkSync(`${tmpDb}-shm`) } catch {}
    })

    it('recovers credit on restart after crash between redeem and settle', async () => {
      const tmpDb = `/tmp/toll-booth-crash-${Date.now()}.db`
      const { paymentHash } = makePreimageAndHash()

      const backend: LightningBackend = {
        createInvoice: vi.fn().mockResolvedValue({ bolt11: 'lnbc1000n1test...', paymentHash }),
        checkInvoice: vi.fn().mockResolvedValue({ paid: false }),
      }

      // Instance 1: simulate claim + redeem + recordRedemption, then "crash" before settle
      const booth1 = new Booth({
        backend, pricing: { '/route': 2 }, upstream: 'http://localhost:8002',
        rootKey: ROOT_KEY, dbPath: tmpDb,
        redeemCashu: vi.fn().mockResolvedValue(500),
      })
      const app1 = new Hono()
      app1.post('/cashu-redeem', booth1.cashuRedeemHandler!)
      app1.use('/*', booth1.middleware)

      // Store invoice
      await app1.request('/route', { method: 'POST' })

      // Simulate partial completion: claim + record redemption, but no settle
      // We access the meter's internals via a fresh CreditMeter on the same DB
      const Database = (await import('better-sqlite3')).default
      const rawDb = new Database(tmpDb)
      rawDb.pragma('journal_mode = WAL')
      const { CreditMeter } = await import('./meter.js')
      const rawMeter = new CreditMeter(rawDb)
      rawMeter.claim(paymentHash)
      rawMeter.recordRedemption(paymentHash, 500)
      // Deliberately skip settleRedemption — simulating crash
      rawDb.close()
      booth1.close()

      // Instance 2: new Booth on same DB — should auto-recover
      const booth2 = new Booth({
        backend, pricing: { '/route': 2 }, upstream: 'http://localhost:8002',
        rootKey: ROOT_KEY, dbPath: tmpDb,
        redeemCashu: vi.fn(),
      })
      const app2 = new Hono()
      app2.use('/*', booth2.middleware)

      // The recovered credit should be usable via L402
      // Get the macaroon from the invoice store (created by booth1)
      const challengeRes = await app2.request('/route', { method: 'POST' })
      const challengeBody = await challengeRes.json()
      const authRes = await app2.request('/route', {
        method: 'POST',
        headers: { 'Authorization': `L402 ${challengeBody.macaroon}:settled` },
      })
      // Should NOT be 402 — credit was recovered
      expect(authRes.status).not.toBe(402)

      booth2.close()
      const { unlinkSync } = await import('node:fs')
      try { unlinkSync(tmpDb) } catch {}
      try { unlinkSync(`${tmpDb}-wal`) } catch {}
      try { unlinkSync(`${tmpDb}-shm`) } catch {}
    })
  })

  it('records stats from middleware events', async () => {
    const { app, booth } = setup()

    // Trigger a 402 challenge
    await app.request('/route', { method: 'POST' })

    const snap = booth.stats.snapshot()
    expect(snap.requests.challenged).toBe(1)

    booth.close()
  })

  it('full flow: 402 -> payment page -> create invoice -> JSON status', async () => {
    const { app, booth, backend, paymentHash, preimage } = setup()

    // 1. Request a priced route, get 402
    const res1 = await app.request('/route', { method: 'POST' })
    expect(res1.status).toBe(402)
    const body1 = await res1.json()
    expect(body1.payment_url).toBeTruthy()

    // 2. Visit payment page (HTML)
    const res2 = await app.request(`/invoice-status/${paymentHash}`, {
      headers: { 'Accept': 'text/html' },
    })
    expect(res2.status).toBe(200)
    const html = await res2.text()
    expect(html).toContain('Payment Required')

    // 3. Create a Pro tier invoice
    const res3 = await app.request('/create-invoice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amountSats: 10_000 }),
    })
    expect(res3.status).toBe(200)

    // 4. Check JSON status
    const res4 = await app.request(`/invoice-status/${paymentHash}`)
    expect(res4.status).toBe(200)
    const body4 = await res4.json()
    expect(body4.paid).toBe(false)

    // 5. Simulate payment completion
    vi.mocked(backend.checkInvoice).mockResolvedValue({ paid: true, preimage })

    const res5 = await app.request(`/invoice-status/${paymentHash}`, {
      headers: { 'Accept': 'text/html' },
    })
    const html5 = await res5.text()
    expect(html5).toContain('Payment Complete')
    expect(html5).toContain(preimage)

    booth.close()
  })
})

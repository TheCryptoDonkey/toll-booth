// src/e2e/l402-flow.integration.test.ts
//
// End-to-end test of the L402 payment flow against real LND nodes.
// Skipped by default — run via: npm run test:integration
//
import { describe, it, expect, afterAll } from 'vitest'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { Booth } from '../booth.js'
import { lndBackend } from '../backends/lnd.js'
import { memoryStorage } from '../storage/memory.js'

const aliceUrl = process.env.LND_REST_URL
const aliceMacaroon = process.env.LND_MACAROON
const bobUrl = process.env.LND_BOB_REST_URL
const bobMacaroon = process.env.LND_BOB_MACAROON
const hasCredentials = !!aliceUrl && !!aliceMacaroon && !!bobUrl && !!bobMacaroon

describe.skipIf(!hasCredentials)('L402 end-to-end flow', () => {
  // Upstream: a trivial Hono app that always returns 200
  const upstream = new Hono()
  upstream.all('/*', (c) => c.json({ ok: true, path: new URL(c.req.url).pathname }))

  let upstreamServer: ReturnType<typeof serve>
  let upstreamPort: number
  let booth: Booth
  let app: Hono

  const setup = () => {
    upstreamPort = 19000 + Math.floor(Math.random() * 1000)
    upstreamServer = serve({ fetch: upstream.fetch, port: upstreamPort })

    const backend = lndBackend({ url: aliceUrl!, macaroon: aliceMacaroon! })

    booth = new Booth({
      adapter: 'hono',
      backend,
      pricing: { '/api/route': 10 },
      upstream: `http://127.0.0.1:${upstreamPort}`,
      rootKey: 'b'.repeat(64),
      storage: memoryStorage(),
      defaultInvoiceAmount: 1000,
    })

    app = new Hono()
    app.get('/invoice-status/:paymentHash', booth.invoiceStatusHandler as any)
    app.post('/create-invoice', booth.createInvoiceHandler as any)
    app.use('/*', booth.middleware as any)
  }

  afterAll(() => {
    booth?.close()
    upstreamServer?.close()
  })

  it('complete L402 flow: 402 → pay → authorise → proxy', async () => {
    setup()

    // 1. Request priced endpoint — get 402
    const challengeRes = await app.request('/api/route')
    expect(challengeRes.status).toBe(402)

    const challenge = await challengeRes.json() as {
      invoice: string
      macaroon: string
      payment_hash: string
      amount_sats: number
    }
    expect(challenge.invoice).toMatch(/^lnbc/)
    expect(challenge.macaroon).toBeTruthy()
    expect(challenge.payment_hash).toMatch(/^[0-9a-f]{64}$/)

    // 2. Bob pays the invoice via LND REST
    const payRes = await fetch(`${bobUrl}/v1/channels/transactions`, {
      method: 'POST',
      headers: {
        'Grpc-Metadata-macaroon': bobMacaroon!,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ payment_request: challenge.invoice }),
    })

    expect(payRes.ok).toBe(true)
    const payData = await payRes.json() as {
      payment_preimage: string
      payment_error?: string
    }
    expect(payData.payment_error).toBeFalsy()

    const preimage = Buffer.from(payData.payment_preimage, 'base64').toString('hex')

    // 3. Request with L402 header — should be authorised and proxied
    const authedRes = await app.request('/api/route', {
      headers: { Authorization: `L402 ${challenge.macaroon}:${preimage}` },
    })

    expect(authedRes.status).toBe(200)
    const body = await authedRes.json()
    expect(body.ok).toBe(true)

    // 4. Verify credit balance header
    const balance = authedRes.headers.get('X-Credit-Balance')
    expect(balance).toBeTruthy()
    // Paid 1000 sats, route costs 10 → balance should be 990
    expect(Number(balance)).toBe(990)
  }, 60_000)

  it('subsequent requests deduct from credit balance', async () => {
    // Uses state from previous test — same booth instance.
    // Need a fresh invoice since the previous one is already settled.
    const challengeRes = await app.request('/api/route')
    expect(challengeRes.status).toBe(402)

    const challenge = await challengeRes.json() as {
      invoice: string
      macaroon: string
    }

    // Bob pays
    const payRes = await fetch(`${bobUrl}/v1/channels/transactions`, {
      method: 'POST',
      headers: {
        'Grpc-Metadata-macaroon': bobMacaroon!,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ payment_request: challenge.invoice }),
    })
    const payData = await payRes.json() as { payment_preimage: string }
    const preimage = Buffer.from(payData.payment_preimage, 'base64').toString('hex')

    // First request: 1000 - 10 = 990
    const r1 = await app.request('/api/route', {
      headers: { Authorization: `L402 ${challenge.macaroon}:${preimage}` },
    })
    expect(r1.status).toBe(200)
    expect(Number(r1.headers.get('X-Credit-Balance'))).toBe(990)

    // Second request: 990 - 10 = 980
    const r2 = await app.request('/api/route', {
      headers: { Authorization: `L402 ${challenge.macaroon}:${preimage}` },
    })
    expect(r2.status).toBe(200)
    expect(Number(r2.headers.get('X-Credit-Balance'))).toBe(980)
  }, 60_000)
})

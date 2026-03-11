// src/backends/lnd.integration.test.ts
//
// Integration test against real LND nodes on regtest.
// Skipped by default — run via: npm run test:integration
//
import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { lndBackend } from './lnd.js'
import { backendConformanceTests } from './conformance.js'

const url = process.env.LND_REST_URL
const macaroon = process.env.LND_MACAROON
const bobUrl = process.env.LND_BOB_REST_URL
const bobMacaroon = process.env.LND_BOB_MACAROON
const hasCredentials = !!url && !!macaroon

describe.skipIf(!hasCredentials)('lnd integration', () => {
  const backend = hasCredentials
    ? lndBackend({ url, macaroon })
    : null as unknown as ReturnType<typeof lndBackend>

  backendConformanceTests('lnd', () => backend)

  it('creates an invoice and checks its status', async () => {
    const invoice = await backend.createInvoice(1, 'integration test')

    expect(invoice.bolt11).toMatch(/^lnbc/)
    expect(invoice.paymentHash).toMatch(/^[0-9a-f]{64}$/)

    const status = await backend.checkInvoice(invoice.paymentHash)
    expect(status.paid).toBe(false)
    expect(status.preimage).toBeUndefined()
  })

  it('returns unpaid for a non-existent payment hash', async () => {
    const fakeHash = '0'.repeat(64)
    const status = await backend.checkInvoice(fakeHash)
    expect(status.paid).toBe(false)
  })

  it('detects payment after Bob pays the invoice', async () => {
    if (!bobUrl || !bobMacaroon) {
      console.error('Skipping paid-path test: LND_BOB_REST_URL / LND_BOB_MACAROON not set')
      return
    }

    // Alice creates an invoice
    const invoice = await backend.createInvoice(100, 'paid path test')
    expect(invoice.bolt11).toMatch(/^lnbc/)

    // Bob pays it via LND REST API
    const payRes = await fetch(`${bobUrl}/v1/channels/transactions`, {
      method: 'POST',
      headers: {
        'Grpc-Metadata-macaroon': bobMacaroon,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ payment_request: invoice.bolt11 }),
    })

    expect(payRes.ok).toBe(true)
    const payData = await payRes.json() as {
      payment_hash: string
      payment_preimage: string
      payment_error?: string
    }
    expect(payData.payment_error).toBeFalsy()

    // Poll until Alice sees the invoice as paid (settlement propagation)
    let status = await backend.checkInvoice(invoice.paymentHash)
    for (let i = 0; i < 20 && !status.paid; i++) {
      await new Promise((r) => setTimeout(r, 250))
      status = await backend.checkInvoice(invoice.paymentHash)
    }
    expect(status.paid).toBe(true)
    expect(status.preimage).toMatch(/^[0-9a-f]{64}$/)

    // Verify preimage matches payment hash (SHA-256)
    const computedHash = createHash('sha256')
      .update(Buffer.from(status.preimage!, 'hex'))
      .digest('hex')
    expect(computedHash).toBe(invoice.paymentHash)
  }, 30_000)
})

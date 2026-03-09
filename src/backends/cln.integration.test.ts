// src/backends/cln.integration.test.ts
//
// Integration test against a real Core Lightning instance.
// Skipped by default — run with CLN_REST_URL and CLN_RUNE env vars:
//
//   CLN_REST_URL=https://localhost:3010 CLN_RUNE=... npx vitest run src/backends/cln.integration.test.ts
//
import { describe, it, expect } from 'vitest'
import { clnBackend } from './cln.js'
import { backendConformanceTests } from './conformance.js'

const url = process.env.CLN_REST_URL
const rune = process.env.CLN_RUNE
const hasCredentials = !!url && !!rune

describe.skipIf(!hasCredentials)('cln integration', () => {
  const backend = hasCredentials
    ? clnBackend({ url, rune })
    : null as unknown as ReturnType<typeof clnBackend>

  backendConformanceTests('cln', () => backend)

  it('creates an invoice and checks its status', async () => {
    const invoice = await backend.createInvoice(1, 'integration test')

    expect(invoice.bolt11).toMatch(/^lnbc/)
    expect(invoice.paymentHash).toMatch(/^[0-9a-f]{64}$/)

    const status = await backend.checkInvoice(invoice.paymentHash)
    expect(status.paid).toBe(false)
    expect(status.preimage).toBeUndefined()
  })
})

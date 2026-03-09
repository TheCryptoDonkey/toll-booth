// src/backends/phoenixd.integration.test.ts
//
// Integration test against a real Phoenixd instance.
// Skipped by default — run with PHOENIXD_URL and PHOENIXD_PASSWORD env vars:
//
//   PHOENIXD_URL=http://localhost:9740 PHOENIXD_PASSWORD=secret npx vitest run src/backends/phoenixd.integration.test.ts
//
import { describe, it, expect } from 'vitest'
import { phoenixdBackend } from './phoenixd.js'
import { backendConformanceTests } from './conformance.js'

const url = process.env.PHOENIXD_URL
const password = process.env.PHOENIXD_PASSWORD
const hasCredentials = !!url && !!password

describe.skipIf(!hasCredentials)('phoenixd integration', () => {
  // Safe: only called when credentials are present (skipIf guards execution)
  const backend = hasCredentials
    ? phoenixdBackend({ url, password })
    : null as unknown as ReturnType<typeof phoenixdBackend>

  backendConformanceTests('phoenixd', () => backend)

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
})

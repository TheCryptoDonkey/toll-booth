// src/core/invoice-status.test.ts
import { describe, it, expect, vi } from 'vitest'
import { handleInvoiceStatus, renderInvoiceStatusHtml, type InvoiceStatusDeps } from './invoice-status.js'
import { memoryStorage } from '../storage/memory.js'
import type { LightningBackend } from '../types.js'

const PAYMENT_HASH = 'b'.repeat(64)
const STATUS_TOKEN = 'c'.repeat(64)

function mockBackend(overrides: Partial<LightningBackend> = {}): LightningBackend {
  return {
    createInvoice: vi.fn().mockResolvedValue({ bolt11: 'lnbc...', paymentHash: PAYMENT_HASH }),
    checkInvoice: vi.fn().mockResolvedValue({ paid: false }),
    ...overrides,
  }
}

function makeDeps(overrides: Partial<InvoiceStatusDeps> = {}): InvoiceStatusDeps {
  const storage = memoryStorage()
  storage.storeInvoice(PAYMENT_HASH, 'lnbc100n1mock...', 1000, 'macaroon123', STATUS_TOKEN)
  return { backend: mockBackend(), storage, ...overrides }
}

describe('handleInvoiceStatus', () => {
  // --- Not found ---

  it('returns not found when statusToken is missing', async () => {
    const deps = makeDeps()
    const result = await handleInvoiceStatus(deps, PAYMENT_HASH, undefined)
    expect(result.found).toBe(false)
    expect(result.paid).toBe(false)
  })

  it('returns not found when statusToken is wrong', async () => {
    const deps = makeDeps()
    const result = await handleInvoiceStatus(deps, PAYMENT_HASH, 'wrong_token')
    expect(result.found).toBe(false)
  })

  it('returns not found for unknown paymentHash', async () => {
    const deps = makeDeps()
    const result = await handleInvoiceStatus(deps, 'd'.repeat(64), STATUS_TOKEN)
    expect(result.found).toBe(false)
  })

  // --- Lightning backend: unpaid ---

  it('returns found + unpaid when backend says not paid', async () => {
    const deps = makeDeps()
    const result = await handleInvoiceStatus(deps, PAYMENT_HASH, STATUS_TOKEN)
    expect(result.found).toBe(true)
    expect(result.paid).toBe(false)
    expect(result.preimage).toBeUndefined()
    expect(result.invoice).toBeDefined()
  })

  // --- Lightning backend: paid ---

  it('returns paid with preimage when backend confirms payment', async () => {
    const preimage = 'e'.repeat(64)
    const backend = mockBackend({
      checkInvoice: vi.fn().mockResolvedValue({ paid: true, preimage }),
    })
    const deps = makeDeps({ backend })
    const result = await handleInvoiceStatus(deps, PAYMENT_HASH, STATUS_TOKEN)
    expect(result.found).toBe(true)
    expect(result.paid).toBe(true)
    expect(result.preimage).toBe(preimage)
    expect(result.tokenSuffix).toBe(preimage)
  })

  // --- Lightning backend: paid but preimage missing (fallback to settlement secret) ---

  it('falls back to settlement secret when paid but no preimage', async () => {
    const backend = mockBackend({
      checkInvoice: vi.fn().mockResolvedValue({ paid: true, preimage: undefined }),
    })
    const storage = memoryStorage()
    storage.storeInvoice(PAYMENT_HASH, 'lnbc...', 1000, 'mac', STATUS_TOKEN)
    storage.settleWithCredit(PAYMENT_HASH, 1000, 'secret123')
    const deps = makeDeps({ backend, storage })
    const result = await handleInvoiceStatus(deps, PAYMENT_HASH, STATUS_TOKEN)
    expect(result.paid).toBe(true)
    expect(result.tokenSuffix).toBe('secret123')
  })

  // --- Cashu-only mode (no backend) ---

  it('returns unsettled in Cashu-only mode when not settled', async () => {
    const storage = memoryStorage()
    storage.storeInvoice(PAYMENT_HASH, '', 1000, 'mac', STATUS_TOKEN)
    const deps: InvoiceStatusDeps = { storage }
    const result = await handleInvoiceStatus(deps, PAYMENT_HASH, STATUS_TOKEN)
    expect(result.found).toBe(true)
    expect(result.paid).toBe(false)
    expect(result.tokenSuffix).toBeUndefined()
  })

  it('returns settled in Cashu-only mode with settlement secret', async () => {
    const storage = memoryStorage()
    storage.storeInvoice(PAYMENT_HASH, '', 1000, 'mac', STATUS_TOKEN)
    storage.settleWithCredit(PAYMENT_HASH, 1000, 'cashu-secret')
    const deps: InvoiceStatusDeps = { storage }
    const result = await handleInvoiceStatus(deps, PAYMENT_HASH, STATUS_TOKEN)
    expect(result.found).toBe(true)
    expect(result.paid).toBe(true)
    expect(result.tokenSuffix).toBe('cashu-secret')
  })

  // --- Invoice data ---

  it('includes invoice data in the result', async () => {
    const deps = makeDeps()
    const result = await handleInvoiceStatus(deps, PAYMENT_HASH, STATUS_TOKEN)
    expect(result.invoice).toBeDefined()
    expect(result.invoice!.paymentHash).toBe(PAYMENT_HASH)
    expect(result.invoice!.bolt11).toBe('lnbc100n1mock...')
    expect(result.invoice!.amountSats).toBe(1000)
  })
})

describe('renderInvoiceStatusHtml', () => {
  it('returns 404 HTML for unknown invoice', async () => {
    const deps = makeDeps()
    const { html, status } = await renderInvoiceStatusHtml(deps, 'd'.repeat(64), STATUS_TOKEN)
    expect(status).toBe(404)
    expect(html).toContain('not found')
  })

  it('returns 404 HTML when statusToken is missing', async () => {
    const deps = makeDeps()
    const { html, status } = await renderInvoiceStatusHtml(deps, PAYMENT_HASH, undefined)
    expect(status).toBe(404)
    expect(html).toContain('not found')
  })

  it('returns 200 HTML for valid invoice', async () => {
    const deps = makeDeps()
    const { html, status } = await renderInvoiceStatusHtml(deps, PAYMENT_HASH, STATUS_TOKEN)
    expect(status).toBe(200)
    expect(html).toContain('<html')
  })

  it('returns 502 HTML when backend throws', async () => {
    const backend = mockBackend({
      checkInvoice: vi.fn().mockRejectedValue(new Error('timeout')),
    })
    const deps = makeDeps({ backend })
    const { html, status } = await renderInvoiceStatusHtml(deps, PAYMENT_HASH, STATUS_TOKEN)
    expect(status).toBe(502)
    expect(html).toContain('try again')
  })

  it('renders paid state with preimage', async () => {
    const preimage = 'e'.repeat(64)
    const backend = mockBackend({
      checkInvoice: vi.fn().mockResolvedValue({ paid: true, preimage }),
    })
    const deps = makeDeps({ backend })
    const { html, status } = await renderInvoiceStatusHtml(deps, PAYMENT_HASH, STATUS_TOKEN)
    expect(status).toBe(200)
    expect(html).toContain(preimage)
  })

  it('renders Cashu-only mode (unsettled)', async () => {
    const storage = memoryStorage()
    storage.storeInvoice(PAYMENT_HASH, '', 1000, 'mac', STATUS_TOKEN)
    const deps: InvoiceStatusDeps = { storage }
    const { html, status } = await renderInvoiceStatusHtml(deps, PAYMENT_HASH, STATUS_TOKEN)
    expect(status).toBe(200)
    expect(html).toContain('<html')
  })
})

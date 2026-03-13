import { describe, it, expect, vi } from 'vitest'
import { handleCashuRedeem } from './cashu-redeem.js'
import { memoryStorage } from '../storage/memory.js'
import type { CashuRedeemDeps } from './cashu-redeem.js'

function createDeps(overrides?: Partial<CashuRedeemDeps>): CashuRedeemDeps {
  const storage = memoryStorage()
  return {
    redeem: vi.fn().mockResolvedValue(1000),
    storage,
    ...overrides,
  }
}

describe('handleCashuRedeem', () => {
  it('returns 400 for missing fields', async () => {
    const deps = createDeps()
    const result = await handleCashuRedeem(deps, { token: '', paymentHash: '', statusToken: '' })
    expect(result.success).toBe(false)
    if (!result.success && 'error' in result) expect(result.status).toBe(400)
  })

  it('rejects oversized cashu token', async () => {
    const deps = createDeps()
    const hash = 'a'.repeat(64)
    const result = await handleCashuRedeem(deps, { token: 'x'.repeat(16_385), paymentHash: hash, statusToken: 'tok' })
    expect(result.success).toBe(false)
    if (!result.success && 'error' in result) expect(result.status).toBe(400)
  })

  it('rejects oversized statusToken', async () => {
    const deps = createDeps()
    const hash = 'a'.repeat(64)
    const result = await handleCashuRedeem(deps, { token: 'cashuA...', paymentHash: hash, statusToken: 'x'.repeat(129) })
    expect(result.success).toBe(false)
    if (!result.success && 'error' in result) expect(result.status).toBe(400)
  })

  it('returns 400 for unknown invoice', async () => {
    const deps = createDeps()
    const hash = 'a'.repeat(64)
    const result = await handleCashuRedeem(deps, { token: 'cashuA...', paymentHash: hash, statusToken: 'tok' })
    expect(result.success).toBe(false)
    if (!result.success && 'error' in result) expect(result.status).toBe(400)
  })

  it('returns settlement secret if already settled', async () => {
    const deps = createDeps()
    const hash = 'a'.repeat(64)
    deps.storage.storeInvoice(hash, '', 1000, 'mac', 'tok')
    deps.storage.settleWithCredit(hash, 1000, 'secret123')
    const result = await handleCashuRedeem(deps, { token: 'cashuA...', paymentHash: hash, statusToken: 'tok' })
    expect(result).toEqual({ success: true, credited: 0, tokenSuffix: 'secret123' })
  })

  it('settles and credits on successful redeem', async () => {
    const deps = createDeps()
    const hash = 'a'.repeat(64)
    deps.storage.storeInvoice(hash, '', 1000, 'mac', 'tok')
    const result = await handleCashuRedeem(deps, { token: 'cashuA...', paymentHash: hash, statusToken: 'tok' })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.credited).toBe(1000)
      expect(result.tokenSuffix).toBeDefined()
    }
    expect(deps.storage.isSettled(hash)).toBe(true)
  })

  it('returns pending when redeem throws', async () => {
    const deps = createDeps({
      redeem: vi.fn().mockRejectedValue(new Error('mint down')),
    })
    const hash = 'a'.repeat(64)
    deps.storage.storeInvoice(hash, '', 1000, 'mac', 'tok')
    const result = await handleCashuRedeem(deps, { token: 'cashuA...', paymentHash: hash, statusToken: 'tok' })
    expect(result.success).toBe(false)
    if (!result.success && 'state' in result) {
      expect(result.state).toBe('pending')
    }
  })

  it('returns 500 when redeem callback returns negative amount', async () => {
    const deps = createDeps({
      redeem: vi.fn().mockResolvedValue(-100),
    })
    const hash = 'a'.repeat(64)
    deps.storage.storeInvoice(hash, '', 1000, 'mac', 'tok')
    const result = await handleCashuRedeem(deps, { token: 'cashuA...', paymentHash: hash, statusToken: 'tok' })
    expect(result.success).toBe(false)
    if (!result.success && 'error' in result) {
      expect(result.status).toBe(500)
      expect(result.error).toContain('negative')
    }
    // Claim should not be stuck pending — it should be clearable
    expect(deps.storage.isSettled(hash)).toBe(false)
  })

  it('returns pending when claim already held by another process', async () => {
    const deps = createDeps()
    const hash = 'a'.repeat(64)
    deps.storage.storeInvoice(hash, '', 1000, 'mac', 'tok')
    // First claim wins
    deps.storage.claimForRedeem(hash, 'other-token', 60_000)
    const result = await handleCashuRedeem(deps, { token: 'cashuA...', paymentHash: hash, statusToken: 'tok' })
    expect(result.success).toBe(false)
    if (!result.success && 'state' in result) {
      expect(result.state).toBe('pending')
    }
  })
})

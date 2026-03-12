import { describe, it, expect, vi } from 'vitest'
import { createL402Rail } from './l402-rail.js'
import { mintMacaroon } from '../macaroon.js'
import { createHash, randomBytes } from 'node:crypto'

function makePreimageAndHash() {
  const preimage = randomBytes(32).toString('hex')
  const paymentHash = createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex')
  return { preimage, paymentHash }
}

const ROOT_KEY = randomBytes(32).toString('hex')

describe('L402Rail', () => {
  describe('detect', () => {
    it('returns true for L402 Authorization header', () => {
      const rail = createL402Rail({
        rootKey: ROOT_KEY,
        storage: mockStorage(),
        defaultAmount: 1000,
      })
      const req = makeRequest({ authorization: 'L402 abc:def' })
      expect(rail.detect(req)).toBe(true)
    })

    it('returns false for missing Authorization header', () => {
      const rail = createL402Rail({
        rootKey: ROOT_KEY,
        storage: mockStorage(),
        defaultAmount: 1000,
      })
      const req = makeRequest({})
      expect(rail.detect(req)).toBe(false)
    })

    it('returns false for Bearer token', () => {
      const rail = createL402Rail({
        rootKey: ROOT_KEY,
        storage: mockStorage(),
        defaultAmount: 1000,
      })
      const req = makeRequest({ authorization: 'Bearer xyz' })
      expect(rail.detect(req)).toBe(false)
    })
  })

  describe('verify', () => {
    it('verifies valid L402 credential', () => {
      const { preimage, paymentHash } = makePreimageAndHash()
      const macaroon = mintMacaroon(ROOT_KEY, paymentHash, 1000)
      const storage = mockStorage()
      storage.isSettled.mockReturnValue(false)
      storage.settleWithCredit.mockReturnValue(true)
      storage.debit.mockReturnValue({ success: true, remaining: 900 })
      storage.balance.mockReturnValue(900)

      const rail = createL402Rail({
        rootKey: ROOT_KEY,
        storage,
        defaultAmount: 1000,
      })

      const req = makeRequest({ authorization: `L402 ${macaroon}:${preimage}` })
      const result = rail.verify(req)

      expect(result.authenticated).toBe(true)
      expect(result.paymentId).toBe(paymentHash)
      expect(result.mode).toBe('credit')
      expect(result.currency).toBe('sat')
    })

    it('rejects invalid preimage', () => {
      const { paymentHash } = makePreimageAndHash()
      const macaroon = mintMacaroon(ROOT_KEY, paymentHash, 1000)
      const storage = mockStorage()
      storage.isSettled.mockReturnValue(false)

      const rail = createL402Rail({
        rootKey: ROOT_KEY,
        storage,
        defaultAmount: 1000,
      })

      const badPreimage = randomBytes(32).toString('hex')
      const req = makeRequest({ authorization: `L402 ${macaroon}:${badPreimage}` })
      const result = rail.verify(req)

      expect(result.authenticated).toBe(false)
    })
  })

  describe('challenge', () => {
    it('generates L402 challenge with invoice and macaroon', async () => {
      const backend = {
        createInvoice: vi.fn().mockResolvedValue({
          bolt11: 'lnbc1000...',
          paymentHash: 'abc123'.padEnd(64, '0'),
        }),
        checkInvoice: vi.fn(),
      }

      const rail = createL402Rail({
        rootKey: ROOT_KEY,
        storage: mockStorage(),
        defaultAmount: 1000,
        backend,
      })

      const result = await rail.challenge('/api/test', { sats: 100 })
      expect(result.headers['WWW-Authenticate']).toMatch(/^L402 /)
      expect(result.body.l402).toBeDefined()
      const l402 = result.body.l402 as Record<string, unknown>
      expect(l402.invoice).toBe('lnbc1000...')
      expect(l402.macaroon).toBeDefined()
      expect(l402.amount_sats).toBe(1000)
    })
  })
})

function mockStorage() {
  return {
    credit: vi.fn(),
    debit: vi.fn().mockReturnValue({ success: true, remaining: 0 }),
    balance: vi.fn().mockReturnValue(0),
    adjustCredits: vi.fn().mockReturnValue(0),
    settle: vi.fn().mockReturnValue(true),
    isSettled: vi.fn().mockReturnValue(false),
    settleWithCredit: vi.fn().mockReturnValue(true),
    getSettlementSecret: vi.fn().mockReturnValue(undefined),
    claimForRedeem: vi.fn().mockReturnValue(true),
    pendingClaims: vi.fn().mockReturnValue([]),
    tryAcquireRecoveryLease: vi.fn().mockReturnValue(undefined),
    extendRecoveryLease: vi.fn().mockReturnValue(true),
    storeInvoice: vi.fn(),
    pendingInvoiceCount: vi.fn().mockReturnValue(0),
    getInvoice: vi.fn().mockReturnValue(undefined),
    getInvoiceForStatus: vi.fn().mockReturnValue(undefined),
    pruneExpiredInvoices: vi.fn().mockReturnValue(0),
    pruneStaleRecords: vi.fn().mockReturnValue(0),
    close: vi.fn(),
  }
}

function makeRequest(headers: Record<string, string>) {
  return {
    method: 'GET',
    path: '/api/test',
    headers,
    ip: '127.0.0.1',
  }
}

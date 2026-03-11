// src/storage/memory.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { memoryStorage } from './memory.js'
import type { StorageBackend } from './interface.js'

describe('memoryStorage', () => {
  let storage: StorageBackend

  beforeEach(() => {
    storage = memoryStorage()
  })

  // --- Credit / Debit / Balance ---

  describe('credit and debit', () => {
    it('starts with zero balance', () => {
      expect(storage.balance('hash1')).toBe(0)
    })

    it('credits increase balance', () => {
      storage.credit('hash1', 1000)
      expect(storage.balance('hash1')).toBe(1000)
    })

    it('credits are additive', () => {
      storage.credit('hash1', 500)
      storage.credit('hash1', 300)
      expect(storage.balance('hash1')).toBe(800)
    })

    it('debit succeeds when sufficient balance', () => {
      storage.credit('hash1', 1000)
      const result = storage.debit('hash1', 100)
      expect(result.success).toBe(true)
      expect(result.remaining).toBe(900)
    })

    it('debit fails when insufficient balance', () => {
      storage.credit('hash1', 50)
      const result = storage.debit('hash1', 100)
      expect(result.success).toBe(false)
      expect(result.remaining).toBe(50)
    })

    it('debit fails on zero balance', () => {
      const result = storage.debit('hash1', 1)
      expect(result.success).toBe(false)
      expect(result.remaining).toBe(0)
    })

    it('debit of exact balance succeeds with zero remaining', () => {
      storage.credit('hash1', 100)
      const result = storage.debit('hash1', 100)
      expect(result.success).toBe(true)
      expect(result.remaining).toBe(0)
    })

    it('balances are independent per paymentHash', () => {
      storage.credit('hash1', 1000)
      storage.credit('hash2', 500)
      expect(storage.balance('hash1')).toBe(1000)
      expect(storage.balance('hash2')).toBe(500)
    })
  })

  // --- Settle ---

  describe('settle', () => {
    it('settle returns true on first call', () => {
      expect(storage.settle('hash1')).toBe(true)
    })

    it('settle returns false on second call (idempotent)', () => {
      storage.settle('hash1')
      expect(storage.settle('hash1')).toBe(false)
    })

    it('isSettled returns false before settlement', () => {
      expect(storage.isSettled('hash1')).toBe(false)
    })

    it('isSettled returns true after settlement', () => {
      storage.settle('hash1')
      expect(storage.isSettled('hash1')).toBe(true)
    })
  })

  // --- settleWithCredit ---

  describe('settleWithCredit', () => {
    it('atomically settles and credits', () => {
      const result = storage.settleWithCredit('hash1', 1000, 'secret')
      expect(result).toBe(true)
      expect(storage.isSettled('hash1')).toBe(true)
      expect(storage.balance('hash1')).toBe(1000)
    })

    it('returns false if already settled', () => {
      storage.settle('hash1')
      const result = storage.settleWithCredit('hash1', 1000, 'secret')
      expect(result).toBe(false)
      expect(storage.balance('hash1')).toBe(0)
    })

    it('stores settlement secret', () => {
      storage.settleWithCredit('hash1', 1000, 'my-secret')
      expect(storage.getSettlementSecret('hash1')).toBe('my-secret')
    })

    it('returns undefined settlement secret for unsettled hash', () => {
      expect(storage.getSettlementSecret('hash1')).toBeUndefined()
    })

    it('clears pending claim on settlement', () => {
      storage.claimForRedeem('hash1', 'token1')
      storage.settleWithCredit('hash1', 1000, 'secret')
      expect(storage.pendingClaims()).toHaveLength(0)
    })

    it('adds to existing balance', () => {
      storage.credit('hash1', 200)
      storage.settleWithCredit('hash1', 1000, 'secret')
      expect(storage.balance('hash1')).toBe(1200)
    })
  })

  // --- Cashu claim / lease ---

  describe('claimForRedeem', () => {
    it('claims successfully for new paymentHash', () => {
      expect(storage.claimForRedeem('hash1', 'token1')).toBe(true)
    })

    it('rejects duplicate claim', () => {
      storage.claimForRedeem('hash1', 'token1')
      expect(storage.claimForRedeem('hash1', 'token2')).toBe(false)
    })

    it('rejects claim for settled hash', () => {
      storage.settle('hash1')
      expect(storage.claimForRedeem('hash1', 'token1')).toBe(false)
    })

    it('appears in pendingClaims', () => {
      storage.claimForRedeem('hash1', 'token1')
      const pending = storage.pendingClaims()
      expect(pending).toHaveLength(1)
      expect(pending[0].paymentHash).toBe('hash1')
      expect(pending[0].token).toBe('token1')
    })

    it('settled claims do not appear in pendingClaims', () => {
      storage.claimForRedeem('hash1', 'token1')
      storage.settleWithCredit('hash1', 1000, 'secret')
      expect(storage.pendingClaims()).toHaveLength(0)
    })
  })

  describe('tryAcquireRecoveryLease', () => {
    it('returns undefined for unknown hash', () => {
      expect(storage.tryAcquireRecoveryLease('hash1', 5000)).toBeUndefined()
    })

    it('returns undefined for settled hash', () => {
      storage.claimForRedeem('hash1', 'token1')
      storage.settle('hash1')
      expect(storage.tryAcquireRecoveryLease('hash1', 5000)).toBeUndefined()
    })

    it('returns undefined while lease is active', () => {
      storage.claimForRedeem('hash1', 'token1', 30_000)
      expect(storage.tryAcquireRecoveryLease('hash1', 5000)).toBeUndefined()
    })

    it('acquires lease after expiry', () => {
      vi.useFakeTimers()
      try {
        storage.claimForRedeem('hash1', 'token1', 1000)
        vi.advanceTimersByTime(1001)
        const claim = storage.tryAcquireRecoveryLease('hash1', 5000)
        expect(claim).toBeDefined()
        expect(claim!.paymentHash).toBe('hash1')
        expect(claim!.token).toBe('token1')
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('extendRecoveryLease', () => {
    it('returns false for unknown hash', () => {
      expect(storage.extendRecoveryLease('hash1', 5000)).toBe(false)
    })

    it('returns false for settled hash', () => {
      storage.claimForRedeem('hash1', 'token1')
      storage.settle('hash1')
      expect(storage.extendRecoveryLease('hash1', 5000)).toBe(false)
    })

    it('extends active lease', () => {
      storage.claimForRedeem('hash1', 'token1', 30_000)
      expect(storage.extendRecoveryLease('hash1', 60_000)).toBe(true)
    })

    it('returns false for expired lease', () => {
      vi.useFakeTimers()
      try {
        storage.claimForRedeem('hash1', 'token1', 1000)
        vi.advanceTimersByTime(1001)
        expect(storage.extendRecoveryLease('hash1', 5000)).toBe(false)
      } finally {
        vi.useRealTimers()
      }
    })
  })

  // --- Invoices ---

  describe('invoices', () => {
    it('stores and retrieves invoice', () => {
      storage.storeInvoice('hash1', 'lnbc...', 1000, 'mac1', 'token1')
      const inv = storage.getInvoice('hash1')
      expect(inv).toBeDefined()
      expect(inv!.paymentHash).toBe('hash1')
      expect(inv!.bolt11).toBe('lnbc...')
      expect(inv!.amountSats).toBe(1000)
      expect(inv!.macaroon).toBe('mac1')
      expect(inv!.createdAt).toBeDefined()
    })

    it('returns undefined for unknown invoice', () => {
      expect(storage.getInvoice('unknown')).toBeUndefined()
    })

    it('does not overwrite existing invoice', () => {
      storage.storeInvoice('hash1', 'lnbc1...', 1000, 'mac1', 'token1')
      storage.storeInvoice('hash1', 'lnbc2...', 2000, 'mac2', 'token2')
      const inv = storage.getInvoice('hash1')
      expect(inv!.bolt11).toBe('lnbc1...')
      expect(inv!.amountSats).toBe(1000)
    })

    it('getInvoiceForStatus requires matching statusToken', () => {
      storage.storeInvoice('hash1', 'lnbc...', 1000, 'mac', 'correct-token')
      expect(storage.getInvoiceForStatus('hash1', 'correct-token')).toBeDefined()
      expect(storage.getInvoiceForStatus('hash1', 'wrong-token')).toBeUndefined()
    })

    it('getInvoiceForStatus does not leak statusToken', () => {
      storage.storeInvoice('hash1', 'lnbc...', 1000, 'mac', 'secret-token')
      const inv = storage.getInvoiceForStatus('hash1', 'secret-token')
      expect(inv).toBeDefined()
      expect(inv).not.toHaveProperty('statusToken')
    })
  })

  // --- Pruning ---

  describe('pruneExpiredInvoices', () => {
    it('prunes invoices older than maxAge', () => {
      vi.useFakeTimers()
      try {
        storage.storeInvoice('old', 'lnbc1...', 100, 'mac1', 'tok1')
        vi.advanceTimersByTime(60_000)
        storage.storeInvoice('new', 'lnbc2...', 200, 'mac2', 'tok2')

        const pruned = storage.pruneExpiredInvoices(30_000)
        expect(pruned).toBe(1)
        expect(storage.getInvoice('old')).toBeUndefined()
        expect(storage.getInvoice('new')).toBeDefined()
      } finally {
        vi.useRealTimers()
      }
    })

    it('returns zero when nothing to prune', () => {
      storage.storeInvoice('hash1', 'lnbc...', 100, 'mac', 'tok')
      expect(storage.pruneExpiredInvoices(999_999_999)).toBe(0)
    })
  })

  // --- Close ---

  describe('close', () => {
    it('clears all state', () => {
      storage.credit('hash1', 1000)
      storage.storeInvoice('hash1', 'lnbc...', 1000, 'mac', 'tok')
      storage.settle('hash1')
      storage.close()

      expect(storage.balance('hash1')).toBe(0)
      expect(storage.getInvoice('hash1')).toBeUndefined()
      expect(storage.isSettled('hash1')).toBe(false)
    })
  })
})

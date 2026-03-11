import { describe, it, expect, vi, beforeEach } from 'vitest'
import { lnbitsBackend } from './lnbits.js'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

beforeEach(() => mockFetch.mockReset())

describe('lnbitsBackend', () => {
  const backend = lnbitsBackend({
    url: 'https://legend.lnbits.com',
    apiKey: 'test-api-key',
  })

  describe('createInvoice', () => {
    it('calls POST /api/v1/payments with JSON body', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          payment_hash: 'abc123',
          payment_request: 'lnbc1500n1pw5kjhm...',
        }),
      })

      const invoice = await backend.createInvoice(100, 'test memo')

      expect(mockFetch).toHaveBeenCalledOnce()
      const [url, opts] = mockFetch.mock.calls[0]
      expect(url).toBe('https://legend.lnbits.com/api/v1/payments')
      expect(opts.method).toBe('POST')
      expect(opts.headers['X-Api-Key']).toBe('test-api-key')
      expect(opts.headers['Content-Type']).toBe('application/json')

      const body = JSON.parse(opts.body)
      expect(body.out).toBe(false)
      expect(body.amount).toBe(100)
      expect(body.memo).toBe('test memo')

      expect(invoice.bolt11).toBe('lnbc1500n1pw5kjhm...')
      expect(invoice.paymentHash).toBe('abc123')
    })

    it('uses default memo when none provided', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          payment_hash: 'abc123',
          payment_request: 'lnbc1500n1pw5kjhm...',
        }),
      })

      await backend.createInvoice(100)

      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(body.memo).toBe('toll-booth payment')
    })

    it('throws on HTTP error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Internal error',
      })

      await expect(backend.createInvoice(100)).rejects.toThrow(/500/)
    })

    it('strips trailing slash from URL', async () => {
      const b = lnbitsBackend({
        url: 'https://legend.lnbits.com/',
        apiKey: 'key',
      })

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ payment_hash: 'h', payment_request: 'lnbc...' }),
      })

      await b.createInvoice(1)
      expect(mockFetch.mock.calls[0][0]).toBe('https://legend.lnbits.com/api/v1/payments')
    })
  })

  describe('checkInvoice', () => {
    it('returns paid=true with preimage when settled', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          paid: true,
          preimage: 'def456',
        }),
      })

      const status = await backend.checkInvoice('abc123')

      expect(mockFetch).toHaveBeenCalledOnce()
      const [url, opts] = mockFetch.mock.calls[0]
      expect(url).toBe('https://legend.lnbits.com/api/v1/payments/abc123')
      expect(opts.headers['X-Api-Key']).toBe('test-api-key')
      expect(status.paid).toBe(true)
      expect(status.preimage).toBe('def456')
    })

    it('returns paid=false when pending', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ paid: false }),
      })

      const status = await backend.checkInvoice('abc123')
      expect(status.paid).toBe(false)
      expect(status.preimage).toBeUndefined()
    })

    it('returns paid=false on 404 (not found)', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 404 })

      const status = await backend.checkInvoice('abc123')
      expect(status.paid).toBe(false)
    })

    it('throws on 401 (auth failure)', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => 'Unauthorised',
      })

      await expect(backend.checkInvoice('abc123')).rejects.toThrow(/401/)
    })

    it('throws on 500 (server error)', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Internal error',
      })

      await expect(backend.checkInvoice('abc123')).rejects.toThrow(/500/)
    })
  })
})

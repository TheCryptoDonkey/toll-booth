import { describe, it, expect, vi } from 'vitest'
import { Booth } from '../booth.js'
import { memoryStorage } from '../storage/memory.js'
import type { X402Facilitator, X402ChallengeWire, X402PaymentWire } from '../core/x402-types.js'
import { X402_VERSION } from '../core/x402-types.js'

function mockFacilitator(): X402Facilitator {
  return {
    verify: vi.fn().mockResolvedValue({
      valid: true,
      txHash: '0x' + 'a'.repeat(62),
      amount: 500,
      sender: '0xsender',
    }),
  }
}

/** Build a base64-encoded v2 PAYMENT-SIGNATURE header. */
function v2PaymentHeader(overrides?: Partial<{ value: string; from: string; nonce: string }>): string {
  const wire: X402PaymentWire = {
    x402Version: X402_VERSION,
    accepted: {
      scheme: 'exact',
      network: 'base',
      amount: overrides?.value ?? '500',
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      payTo: '0xreceiver',
      maxTimeoutSeconds: 3600,
      extra: {},
    },
    payload: {
      signature: '0xsig',
      authorization: {
        from: overrides?.from ?? '0xsender',
        to: '0xreceiver',
        value: overrides?.value ?? '500',
        validAfter: '0',
        validBefore: String(Math.floor(Date.now() / 1000) + 3600),
        nonce: overrides?.nonce ?? '0xnonce1',
      },
    },
  }
  return Buffer.from(JSON.stringify(wire)).toString('base64')
}

describe('x402 integration flow', () => {
  it('returns 402 with v2 Payment-Required header', async () => {
    const booth = new Booth({
      adapter: 'express',
      upstream: 'http://localhost:3000',
      pricing: { '/api/test': { sats: 100, usd: 5 } },
      storage: memoryStorage(),
      x402: {
        receiverAddress: '0xreceiver',
        network: 'base',
        facilitator: mockFacilitator(),
      },
    })

    const result = await booth['engine'].handle({
      method: 'GET', path: '/api/test',
      headers: {}, ip: '127.0.0.1',
    })

    expect(result.action).toBe('challenge')
    if (result.action === 'challenge') {
      expect(result.status).toBe(402)

      // v2 header present and decodable
      const encoded = result.headers['Payment-Required']
      expect(encoded).toBeDefined()
      const decoded = JSON.parse(Buffer.from(encoded!, 'base64').toString()) as X402ChallengeWire
      expect(decoded.x402Version).toBe(X402_VERSION)
      expect(decoded.accepts[0].payTo).toBe('0xreceiver')
      expect(decoded.accepts[0].amount).toBe('5')

      // Human-readable body also present
      const x402 = result.body.x402 as Record<string, unknown>
      expect(x402).toBeDefined()
      expect(x402.receiver).toBe('0xreceiver')
      expect(x402.amount_usd).toBe(5)
    }

    booth.close()
  })

  it('accepts v2 PAYMENT-SIGNATURE header', async () => {
    const facilitator = mockFacilitator()
    const booth = new Booth({
      adapter: 'express',
      upstream: 'http://localhost:3000',
      pricing: { '/api/test': { sats: 100, usd: 5 } },
      storage: memoryStorage(),
      x402: {
        receiverAddress: '0xreceiver',
        network: 'base',
        facilitator,
        creditMode: true,
      },
    })

    const result = await booth['engine'].handle({
      method: 'GET', path: '/api/test',
      headers: { 'payment-signature': v2PaymentHeader() },
      ip: '127.0.0.1',
    })

    expect(result.action).toBe('proxy')
    if (result.action === 'proxy') {
      expect(result.creditBalance).toBe(495) // 500 - 5
    }

    booth.close()
  })

  it('rejects replayed x402 payment in per-request mode', async () => {
    const facilitator = mockFacilitator()
    const booth = new Booth({
      adapter: 'express',
      upstream: 'http://localhost:3000',
      pricing: { '/api/test': { sats: 100, usd: 5 } },
      storage: memoryStorage(),
      x402: {
        receiverAddress: '0xreceiver',
        network: 'base',
        facilitator,
        creditMode: false,
      },
    })

    const header = v2PaymentHeader()

    // First request -- should succeed
    const result1 = await booth['engine'].handle({
      method: 'GET', path: '/api/test',
      headers: { 'payment-signature': header }, ip: '127.0.0.1',
    })
    expect(result1.action).toBe('proxy')

    // Replay -- should be rejected (falls through to challenge)
    const result2 = await booth['engine'].handle({
      method: 'GET', path: '/api/test',
      headers: { 'payment-signature': header }, ip: '127.0.0.1',
    })
    expect(result2.action).toBe('challenge')

    booth.close()
  })

  it('x402 credit mode: pays once, debits across multiple requests', async () => {
    const facilitator = mockFacilitator()
    const booth = new Booth({
      adapter: 'express',
      upstream: 'http://localhost:3000',
      pricing: { '/api/test': { sats: 100, usd: 5 } },
      storage: memoryStorage(),
      x402: {
        receiverAddress: '0xreceiver',
        network: 'base',
        facilitator,
        creditMode: true,
      },
    })

    const header = v2PaymentHeader()

    // First request with payment -- should settle credits and debit
    const result1 = await booth['engine'].handle({
      method: 'GET', path: '/api/test',
      headers: { 'payment-signature': header }, ip: '127.0.0.1',
    })
    expect(result1.action).toBe('proxy')
    if (result1.action === 'proxy') {
      expect(result1.creditBalance).toBe(495) // 500 - 5
    }

    // Second request -- same payment, credits already settled, debit again
    const result2 = await booth['engine'].handle({
      method: 'GET', path: '/api/test',
      headers: { 'payment-signature': header }, ip: '127.0.0.1',
    })
    expect(result2.action).toBe('proxy')
    if (result2.action === 'proxy') {
      expect(result2.creditBalance).toBe(490) // 495 - 5
    }

    booth.close()
  })

  it('still accepts legacy x-payment header', async () => {
    const facilitator = mockFacilitator()
    const booth = new Booth({
      adapter: 'express',
      upstream: 'http://localhost:3000',
      pricing: { '/api/test': { sats: 100, usd: 5 } },
      storage: memoryStorage(),
      x402: {
        receiverAddress: '0xreceiver',
        network: 'base',
        facilitator,
        creditMode: true,
      },
    })

    const payload = JSON.stringify({
      signature: 'sig', sender: '0xs', amount: 500, network: 'base', nonce: 'n1',
    })

    const result = await booth['engine'].handle({
      method: 'GET', path: '/api/test',
      headers: { 'x-payment': payload }, ip: '127.0.0.1',
    })

    expect(result.action).toBe('proxy')

    booth.close()
  })
})

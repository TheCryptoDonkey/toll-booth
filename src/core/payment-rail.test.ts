import { describe, it, expect } from 'vitest'
import { normalisePricing, normalisePricingTable } from './payment-rail.js'

describe('normalisePricing', () => {
  it('converts number to sats-only PriceInfo', () => {
    expect(normalisePricing(50)).toEqual({ sats: 50 })
  })

  it('passes PriceInfo through unchanged', () => {
    expect(normalisePricing({ sats: 50, usd: 2 })).toEqual({ sats: 50, usd: 2 })
  })

  it('handles usd-only PriceInfo', () => {
    expect(normalisePricing({ usd: 5 })).toEqual({ usd: 5 })
  })

  it('handles zero', () => {
    expect(normalisePricing(0)).toEqual({ sats: 0 })
  })
})

describe('normalisePricingTable', () => {
  it('normalises mixed table', () => {
    const table = {
      '/api/a': 100,
      '/api/b': { sats: 50, usd: 2 },
      '/api/c': { usd: 5 },
    }
    expect(normalisePricingTable(table)).toEqual({
      '/api/a': { sats: 100 },
      '/api/b': { sats: 50, usd: 2 },
      '/api/c': { usd: 5 },
    })
  })
})

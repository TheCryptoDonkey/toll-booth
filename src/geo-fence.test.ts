import { describe, it, expect } from 'vitest'
import { OFAC_SANCTIONED, isBlockedCountry } from './geo-fence.js'

describe('OFAC_SANCTIONED', () => {
  it('is a frozen array of uppercase ISO 3166-1 alpha-2 codes', () => {
    expect(Object.isFrozen(OFAC_SANCTIONED)).toBe(true)
    for (const code of OFAC_SANCTIONED) {
      expect(code).toMatch(/^[A-Z]{2}$/)
    }
  })

  it('includes the five fully-sanctioned jurisdictions', () => {
    expect(OFAC_SANCTIONED).toContain('CU')
    expect(OFAC_SANCTIONED).toContain('IR')
    expect(OFAC_SANCTIONED).toContain('KP')
    expect(OFAC_SANCTIONED).toContain('SY')
    expect(OFAC_SANCTIONED).toContain('RU')
  })
})

describe('isBlockedCountry', () => {
  const blocked = ['KP', 'IR']

  it('returns true for blocked country', () => {
    expect(isBlockedCountry({ 'cf-ipcountry': 'KP' }, 'CF-IPCountry', blocked)).toBe(true)
  })

  it('returns false for unblocked country', () => {
    expect(isBlockedCountry({ 'cf-ipcountry': 'GB' }, 'CF-IPCountry', blocked)).toBe(false)
  })

  it('returns false when header is absent', () => {
    expect(isBlockedCountry({}, 'CF-IPCountry', blocked)).toBe(false)
  })

  it('matches case-insensitively on header value', () => {
    expect(isBlockedCountry({ 'cf-ipcountry': 'kp' }, 'CF-IPCountry', blocked)).toBe(true)
  })

  it('looks up header name case-insensitively', () => {
    expect(isBlockedCountry({ 'CF-IPCOUNTRY': 'KP' }, 'cf-ipcountry', blocked)).toBe(true)
  })

  it('returns false for empty blockedCountries', () => {
    expect(isBlockedCountry({ 'cf-ipcountry': 'KP' }, 'CF-IPCountry', [])).toBe(false)
  })

  it('returns false for undefined header value', () => {
    expect(isBlockedCountry({ 'cf-ipcountry': undefined }, 'CF-IPCountry', blocked)).toBe(false)
  })

  it('normalises lowercase blockedCountries entries', () => {
    const lowercaseBlocked = ['kp', 'ir']
    expect(isBlockedCountry({ 'cf-ipcountry': 'KP' }, 'CF-IPCountry', lowercaseBlocked)).toBe(true)
  })
})

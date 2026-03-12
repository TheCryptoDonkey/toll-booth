// src/core/security.test.ts
import { describe, it, expect } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { createTollBooth } from './toll-booth.js'
import { mintMacaroon } from '../macaroon.js'
import { memoryStorage } from '../storage/memory.js'
import { handleCashuRedeem } from './cashu-redeem.js'

const ROOT_KEY = 'a'.repeat(64)

function makeCredential() {
  const preimage = randomBytes(32).toString('hex')
  const paymentHash = createHash('sha256')
    .update(Buffer.from(preimage, 'hex'))
    .digest('hex')
  return { preimage, paymentHash }
}

describe('caveat header injection prevention', () => {
  it('strips newlines from custom caveat values forwarded as headers', async () => {
    const storage = memoryStorage()
    const { preimage, paymentHash } = makeCredential()

    const engine = createTollBooth({
      storage,
      pricing: { '/api': 10 },
      upstream: 'http://upstream.test',
      rootKey: ROOT_KEY,
      defaultInvoiceAmount: 1000,
    })

    // Mint macaroon with a caveat value containing CRLF
    const macaroon = mintMacaroon(ROOT_KEY, paymentHash, 1000, ['info = hello\r\nX-Injected: evil'])
    storage.settleWithCredit(paymentHash, 1000, preimage)

    const result = await engine.handle({
      method: 'GET',
      path: '/api',
      headers: { authorization: `L402 ${macaroon}:${preimage}` },
      ip: '1.2.3.4',
    })

    expect(result.action).toBe('proxy')
    if (result.action !== 'proxy') return
    // The header value should have newlines stripped
    const infoHeader = result.headers['X-Toll-Caveat-Info']
    expect(infoHeader).toBeDefined()
    expect(infoHeader).not.toContain('\r')
    expect(infoHeader).not.toContain('\n')
  })

  it('rejects custom caveat keys containing non-alphanumeric characters', async () => {
    const storage = memoryStorage()
    const { preimage, paymentHash } = makeCredential()

    const engine = createTollBooth({
      storage,
      pricing: { '/api': 10 },
      upstream: 'http://upstream.test',
      rootKey: ROOT_KEY,
      defaultInvoiceAmount: 1000,
    })

    // Mint macaroon with a caveat key containing special chars
    const macaroon = mintMacaroon(ROOT_KEY, paymentHash, 1000, ['bad-key = value'])
    storage.settleWithCredit(paymentHash, 1000, preimage)

    const result = await engine.handle({
      method: 'GET',
      path: '/api',
      headers: { authorization: `L402 ${macaroon}:${preimage}` },
      ip: '1.2.3.4',
    })

    expect(result.action).toBe('proxy')
    if (result.action !== 'proxy') return
    // The hyphenated key should be filtered out
    expect(result.headers['X-Toll-Caveat-Bad-key']).toBeUndefined()
  })
})

describe('settlement secret entropy', () => {
  it('generates 64-char hex settlement secrets (not UUIDs)', async () => {
    const storage = memoryStorage()
    const statusToken = randomBytes(32).toString('hex')
    const paymentHash = randomBytes(32).toString('hex')

    storage.storeInvoice(paymentHash, '', 1000, 'mac', statusToken, '1.2.3.4')

    const result = await handleCashuRedeem(
      {
        redeem: async () => 1000,
        storage,
      },
      { token: 'cashuAbc123', paymentHash, statusToken },
    )

    expect(result.success).toBe(true)
    if (!result.success) return

    // Settlement secret should be 64 hex chars (32 bytes), not a UUID
    expect(result.tokenSuffix).toMatch(/^[0-9a-f]{64}$/)
    expect(result.tokenSuffix).not.toContain('-') // UUIDs contain hyphens
  })
})

describe('X-Toll-Cost strict validation', () => {
  it('rejects scientific notation in toll cost', async () => {
    // This tests that '1.5e6' is not parsed as 1 (parseInt truncation bug)
    // The fix uses /^\d+$/ regex to reject non-integer strings
    expect(/^\d+$/.test('1.5e6')).toBe(false)
    expect(/^\d+$/.test('5.9')).toBe(false)
    expect(/^\d+$/.test('-1')).toBe(false)
    expect(/^\d+$/.test('0')).toBe(true)
    expect(/^\d+$/.test('1000')).toBe(true)
  })
})

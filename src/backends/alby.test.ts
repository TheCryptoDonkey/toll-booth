import { describe, it, expect } from 'vitest'
import { albyBackend } from './alby.js'

describe('albyBackend', () => {
  it('throws if NWC URL is missing relay or secret', () => {
    expect(() => albyBackend({ nwcUrl: 'nostr+walletconnect://pubkey' })).toThrow()
    expect(() =>
      albyBackend({ nwcUrl: 'nostr+walletconnect://pubkey?relay=wss://relay.example.com' }),
    ).toThrow()
    expect(() =>
      albyBackend({ nwcUrl: 'nostr+walletconnect://pubkey?secret=deadbeef' }),
    ).toThrow()
  })

  it('parses valid NWC URL without throwing', () => {
    const backend = albyBackend({
      nwcUrl: 'nostr+walletconnect://pubkey?relay=wss://relay.example.com&secret=deadbeef',
    })
    expect(backend.createInvoice).toBeDefined()
    expect(backend.checkInvoice).toBeDefined()
  })

  it('returns unpaid for unknown payment hash', async () => {
    const backend = albyBackend({
      nwcUrl: 'nostr+walletconnect://pubkey?relay=wss://relay.example.com&secret=deadbeef',
    })
    const status = await backend.checkInvoice('unknown')
    expect(status).toEqual({ paid: false })
  })
})

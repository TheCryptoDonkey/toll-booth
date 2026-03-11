import { beforeEach, describe, expect, it, vi } from 'vitest'
import { albyBackend } from './alby.js'

const wsRequests: Array<{ method: string; params: Record<string, unknown> }> = []
let wsResponses: Record<string, unknown>

class MockWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSED = 3

  readyState = MockWebSocket.CONNECTING
  private readonly handlers = new Map<string, Array<(data?: Buffer | string) => void>>()

  constructor(_url: string) {
    queueMicrotask(() => {
      this.readyState = MockWebSocket.OPEN
      this.emit('open')
    })
  }

  on(event: string, handler: (data?: Buffer | string) => void): void {
    const handlers = this.handlers.get(event) ?? []
    handlers.push(handler)
    this.handlers.set(event, handlers)
  }

  send(payload: string): void {
    const request = JSON.parse(payload) as { method: string; params: Record<string, unknown> }
    wsRequests.push(request)

    const response = wsResponses[request.method] ?? { error: { message: `Unhandled method: ${request.method}` } }
    queueMicrotask(() => {
      this.emit('message', Buffer.from(JSON.stringify(response)))
    })
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED
  }

  private emit(event: string, data?: Buffer | string): void {
    for (const handler of this.handlers.get(event) ?? []) {
      handler(data)
    }
  }
}

vi.mock('ws', () => ({ default: MockWebSocket }))

describe('albyBackend', () => {
  beforeEach(() => {
    wsRequests.length = 0
    wsResponses = {
      make_invoice: {
        result: {
          invoice: 'lnbc100n1mock...',
          payment_hash: 'a'.repeat(64),
        },
      },
      lookup_invoice: {
        result: {
          settled: true,
          preimage: 'b'.repeat(64),
        },
      },
    }
  })

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

  it('looks up settlement state for created invoices', async () => {
    const backend = albyBackend({
      nwcUrl: 'nostr+walletconnect://pubkey?relay=wss://relay.example.com&secret=deadbeef',
    })

    const invoice = await backend.createInvoice(100, 'test memo')
    expect(invoice).toEqual({
      bolt11: 'lnbc100n1mock...',
      paymentHash: 'a'.repeat(64),
    })
    expect(wsRequests[0]).toMatchObject({
      method: 'make_invoice',
      params: {
        amount: 100_000,
        description: 'test memo',
      },
    })

    const status = await backend.checkInvoice(invoice.paymentHash)
    expect(status).toEqual({ paid: true, preimage: 'b'.repeat(64) })
    expect(wsRequests[1]).toMatchObject({
      method: 'lookup_invoice',
      params: {
        payment_hash: invoice.paymentHash,
      },
    })
  })
})

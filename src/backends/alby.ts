import type { LightningBackend, Invoice, InvoiceStatus } from '../types.js'

export interface AlbyConfig {
  /** NWC connection URI: nostr+walletconnect://pubkey?relay=wss://...&secret=... */
  nwcUrl: string
  /** Request timeout in ms (default: 30000) */
  timeout?: number
}

interface NwcParams {
  pubkey: string
  relay: string
  secret: string
}

function parseNwcUrl(nwcUrl: string): NwcParams {
  // Replace the custom scheme so URL parser can handle it
  const url = new URL(nwcUrl.replace('nostr+walletconnect://', 'https://'))
  const pubkey = url.hostname
  const relay = url.searchParams.get('relay')
  const secret = url.searchParams.get('secret')

  if (!relay) throw new Error('NWC URL missing required "relay" parameter')
  if (!secret) throw new Error('NWC URL missing required "secret" parameter')

  return { pubkey, relay, secret }
}

/**
 * Lightning backend adapter for Alby / Nostr Wallet Connect (NWC).
 *
 * This is a simplified implementation that sends JSON requests directly
 * to an NWC relay. For production NWC, you'd encrypt messages with
 * NIP-04/NIP-44. This works with NWC proxies that accept JSON directly.
 *
 * The `ws` package is imported dynamically so it only needs to be
 * installed when this backend is actually used.
 */
export function albyBackend(config: AlbyConfig): LightningBackend {
  const params = parseNwcUrl(config.nwcUrl)
  const timeoutMs = config.timeout ?? 30_000

  // NWC doesn't support lookup by payment hash, so we track invoices in memory
  const invoiceMap = new Map<string, { bolt11: string; paid: boolean }>()

  return {
    async createInvoice(amountSats: number, memo?: string): Promise<Invoice> {
      const { default: WebSocket } = await import('ws')

      return new Promise<Invoice>((resolve, reject) => {
        const ws = new WebSocket(params.relay)
        let settled = false

        const cleanup = () => {
          if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
            ws.close()
          }
        }

        const timer = setTimeout(() => {
          if (!settled) {
            settled = true
            cleanup()
            reject(new Error('NWC request timed out'))
          }
        }, timeoutMs)

        ws.on('open', () => {
          const request = JSON.stringify({
            method: 'make_invoice',
            params: {
              amount: amountSats * 1000, // NWC uses millisats
              description: memo,
            },
          })
          ws.send(request)
        })

        ws.on('message', (data: Buffer | string) => {
          if (settled) return
          settled = true
          clearTimeout(timer)

          try {
            const response = JSON.parse(data.toString())
            const result = response.result ?? response

            const bolt11 = result.invoice ?? result.bolt11
            const paymentHash = result.payment_hash

            if (!bolt11 || !paymentHash) {
              cleanup()
              reject(new Error('NWC response missing invoice or payment_hash'))
              return
            }

            invoiceMap.set(paymentHash, { bolt11, paid: false })
            cleanup()
            resolve({ bolt11, paymentHash })
          } catch (err) {
            cleanup()
            reject(new Error(`Failed to parse NWC response: ${err}`))
          }
        })

        ws.on('error', (err: Error) => {
          if (!settled) {
            settled = true
            clearTimeout(timer)
            reject(new Error(`NWC WebSocket error: ${err.message}`))
          }
        })
      })
    },

    async checkInvoice(paymentHash: string): Promise<InvoiceStatus> {
      const entry = invoiceMap.get(paymentHash)
      if (!entry) return { paid: false }
      return { paid: entry.paid }
    },
  }
}

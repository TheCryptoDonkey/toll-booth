import type { LightningBackend, Invoice, InvoiceStatus } from '../types.js'

export interface AlbyConfig {
  /** NWC connection URI: nostr+walletconnect://pubkey?relay=wss://...&secret=... */
  nwcUrl: string
  /** Request timeout in ms (default: 30000) */
  timeout?: number
  /**
   * Opt into the current insecure JSON-over-relay transport.
   * This exists only for local testing and trusted relay experiments.
   */
  allowInsecureRelay?: boolean
}

interface NwcParams {
  pubkey: string
  relay: string
  secret: string
}

interface NwcLookupResult {
  paid?: boolean
  settled?: boolean
  settled_at?: number | string
  state?: string
  preimage?: string
  payment_preimage?: string
  payment_hash?: string
  paymentHash?: string
  invoice?: string
  bolt11?: string
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
 * This transport is intentionally disabled by default because it sends
 * unsigned, unencrypted JSON directly to the relay and therefore cannot
 * authenticate responses. Pass `allowInsecureRelay: true` only for local
 * testing or a fully trusted relay shim.
 *
 * The `ws` package is imported dynamically so it only needs to be
 * installed when this backend is actually used.
 */
export function albyBackend(config: AlbyConfig): LightningBackend {
  if (!config.allowInsecureRelay) {
    throw new Error(
      'albyBackend is disabled by default because its JSON relay transport is unauthenticated; pass allowInsecureRelay: true only for local testing',
    )
  }

  const params = parseNwcUrl(config.nwcUrl)
  const timeoutMs = config.timeout ?? 30_000

  const MAX_CACHED_INVOICES = 10_000
  const invoiceMap = new Map<string, { bolt11: string; paid: boolean; preimage?: string }>()

  return {
    async createInvoice(amountSats: number, memo?: string): Promise<Invoice> {
      const result = await sendNwcRequest<Record<string, unknown>>(
        params,
        timeoutMs,
        'make_invoice',
        {
          amount: amountSats * 1000, // NWC uses millisats
          description: memo,
        },
      )

      const bolt11 = getStringField(result, 'invoice') ?? getStringField(result, 'bolt11')
      const paymentHash = getStringField(result, 'payment_hash') ?? getStringField(result, 'paymentHash')

      if (!bolt11 || !paymentHash) {
        throw new Error('NWC response missing invoice or payment_hash')
      }

      // Evict oldest entries when cache is full (Map preserves insertion order)
      if (invoiceMap.size >= MAX_CACHED_INVOICES) {
        const oldest = invoiceMap.keys().next().value!
        invoiceMap.delete(oldest)
      }
      invoiceMap.set(paymentHash, { bolt11, paid: false })
      return { bolt11, paymentHash }
    },

    async checkInvoice(paymentHash: string): Promise<InvoiceStatus> {
      const entry = invoiceMap.get(paymentHash)
      if (!entry) return { paid: false }

      if (entry.paid) {
        return { paid: true, preimage: entry.preimage }
      }

      const result = await sendNwcRequest<NwcLookupResult>(
        params,
        timeoutMs,
        'lookup_invoice',
        { payment_hash: paymentHash },
      )
      const lookupRecord = result as Record<string, unknown>

      const paid = isPaid(result)
      const preimage = paid
        ? getStringField(lookupRecord, 'payment_preimage') ?? getStringField(lookupRecord, 'preimage')
        : undefined
      const bolt11 = getStringField(lookupRecord, 'invoice') ?? getStringField(lookupRecord, 'bolt11') ?? entry.bolt11

      invoiceMap.set(paymentHash, { bolt11, paid, preimage })
      return { paid, preimage }
    },
  }
}

async function sendNwcRequest<T>(
  params: NwcParams,
  timeoutMs: number,
  method: string,
  requestParams: Record<string, unknown>,
): Promise<T> {
  const { default: WebSocket } = await import('ws')

  return new Promise<T>((resolve, reject) => {
    const ws = new WebSocket(params.relay)
    let settled = false

    const cleanup = () => {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close()
      }
    }

    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      cleanup()
      fn()
    }

    const timer = setTimeout(() => {
      finish(() => reject(new Error(`NWC ${method} timed out`)))
    }, timeoutMs)

    ws.on('open', () => {
      ws.send(JSON.stringify({
        method,
        params: requestParams,
      }))
    })

    ws.on('message', (data: Buffer | string) => {
      finish(() => {
        try {
          const response = JSON.parse(data.toString()) as Record<string, unknown>
          const error = response.error
          if (error) {
            reject(new Error(`NWC ${method} failed: ${formatError(error)}`))
            return
          }

          resolve((response.result ?? response) as T)
        } catch (err) {
          reject(new Error(`Failed to parse NWC response: ${err}`))
        }
      })
    })

    ws.on('error', (err: Error) => {
      finish(() => reject(new Error(`NWC WebSocket error: ${err.message}`)))
    })
  })
}

function getStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function isPaid(result: NwcLookupResult): boolean {
  return result.paid === true ||
    result.settled === true ||
    result.state === 'paid' ||
    result.state === 'settled' ||
    result.settled_at !== undefined
}

function formatError(error: unknown): string {
  if (typeof error === 'string') return error
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
    return error.message
  }
  return 'unknown error'
}

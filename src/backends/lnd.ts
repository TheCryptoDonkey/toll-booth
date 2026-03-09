import type { LightningBackend, Invoice, InvoiceStatus } from '../types.js'

export interface LndConfig {
  /** LND REST API URL (e.g. https://localhost:8080). */
  url: string
  /** Hex-encoded admin macaroon. */
  macaroon: string
}

/**
 * Lightning backend adapter for LND's REST API.
 *
 * Uses the `/v1/invoices` and `/v1/invoice/{r_hash}` endpoints.
 * Authentication via `Grpc-Metadata-macaroon` header with hex-encoded macaroon.
 *
 * @see https://lightning.engineering/api-docs/api/lnd/lightning/add-invoice
 * @see https://lightning.engineering/api-docs/api/lnd/lightning/lookup-invoice
 */
export function lndBackend(config: LndConfig): LightningBackend {
  const baseUrl = config.url.replace(/\/$/, '')
  const headers: Record<string, string> = {
    'Grpc-Metadata-macaroon': config.macaroon,
  }

  return {
    async createInvoice(amountSats: number, memo?: string): Promise<Invoice> {
      const body: Record<string, string> = { value: String(amountSats) }
      if (memo) body.memo = memo

      const res = await fetch(`${baseUrl}/v1/invoices`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`LND createInvoice failed (${res.status}): ${text}`)
      }

      const data = await res.json() as { r_hash: string; payment_request: string }
      return {
        bolt11: data.payment_request,
        paymentHash: Buffer.from(data.r_hash, 'base64').toString('hex'),
      }
    },

    async checkInvoice(paymentHash: string): Promise<InvoiceStatus> {
      const res = await fetch(`${baseUrl}/v1/invoice/${paymentHash}`, {
        headers,
      })

      if (res.status === 404) return { paid: false }

      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`LND checkInvoice failed (${res.status}): ${text}`)
      }

      const data = await res.json() as { state: string; r_preimage?: string }
      const paid = data.state === 'SETTLED'
      return {
        paid,
        preimage: paid && data.r_preimage
          ? Buffer.from(data.r_preimage, 'base64').toString('hex')
          : undefined,
      }
    },
  }
}

import type { StorageBackend } from '../storage/interface.js'
import type { NwcPayRequest, NwcPayResult } from './types.js'
import { PAYMENT_HASH_RE } from './types.js'

export interface NwcPayDeps {
  nwcPay: (nwcUri: string, bolt11: string) => Promise<string>
  storage: StorageBackend
}

export async function handleNwcPay(
  deps: NwcPayDeps,
  request: NwcPayRequest,
): Promise<NwcPayResult> {
  try {
    const { nwcUri, bolt11, paymentHash, statusToken } = request
    if (
      typeof nwcUri !== 'string' || !nwcUri ||
      typeof bolt11 !== 'string' || !bolt11 ||
      !PAYMENT_HASH_RE.test(paymentHash) ||
      typeof statusToken !== 'string' || !statusToken
    ) {
      return { success: false, error: 'Invalid request: nwcUri, bolt11, paymentHash and statusToken required', status: 400 }
    }

    const invoice = deps.storage.getInvoiceForStatus(paymentHash, statusToken)
    if (!invoice || invoice.bolt11 !== bolt11) {
      return { success: false, error: 'Unknown invoice or invoice mismatch', status: 400 }
    }

    const preimage = await deps.nwcPay(nwcUri, invoice.bolt11)
    return { success: true, preimage }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'NWC payment failed'
    return { success: false, error: message, status: 500 }
  }
}

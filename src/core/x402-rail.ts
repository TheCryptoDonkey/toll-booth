import type { TollBoothRequest } from './types.js'
import type { PaymentRail, PriceInfo, ChallengeFragment, RailVerifyResult } from './payment-rail.js'
import type { X402RailConfig, X402Payment } from './x402-types.js'
import { DEFAULT_USDC_ASSETS } from './x402-types.js'

export function createX402Rail(config: X402RailConfig): PaymentRail {
  const {
    receiverAddress,
    network,
    asset = DEFAULT_USDC_ASSETS[network],
    facilitator,
    creditMode = true,
    facilitatorUrl,
  } = config

  return {
    type: 'x402',
    creditSupported: true,

    canChallenge(price: PriceInfo): boolean {
      return price.usd !== undefined
    },

    detect(req: TollBoothRequest): boolean {
      return req.headers['x-payment'] !== undefined
    },

    async challenge(_route: string, price: PriceInfo): Promise<ChallengeFragment> {
      return {
        headers: { 'X-Payment-Required': 'x402' },
        body: {
          x402: {
            receiver: receiverAddress,
            network,
            asset,
            amount_usd: price.usd,
            ...(facilitatorUrl && { facilitator: facilitatorUrl }),
          },
        },
      }
    },

    async verify(req: TollBoothRequest): Promise<RailVerifyResult> {
      const raw = req.headers['x-payment']
      if (!raw) {
        return { authenticated: false, paymentId: '', mode: 'per-request', currency: 'usd' }
      }

      let payload: X402Payment
      try {
        payload = JSON.parse(raw)
      } catch {
        return { authenticated: false, paymentId: '', mode: 'per-request', currency: 'usd' }
      }

      try {
        const result = await facilitator.verify(payload)
        if (!result.valid) {
          return { authenticated: false, paymentId: result.txHash || '', mode: 'per-request', currency: 'usd' }
        }

        return {
          authenticated: true,
          paymentId: result.txHash,
          mode: creditMode ? 'credit' : 'per-request',
          creditBalance: creditMode ? result.amount : undefined,
          currency: 'usd',
        }
      } catch {
        return { authenticated: false, paymentId: '', mode: 'per-request', currency: 'usd' }
      }
    },

  }
}

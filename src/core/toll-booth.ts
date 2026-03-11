// src/core/toll-booth.ts
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { mintMacaroon, verifyMacaroon } from '../macaroon.js'
import { FreeTier } from '../free-tier.js'
import type { StorageBackend } from '../storage/interface.js'
import type { TollBoothRequest, TollBoothResult, TollBoothCoreConfig } from './types.js'

export interface TollBoothEngine {
  handle(req: TollBoothRequest): Promise<TollBoothResult>
  freeTier: FreeTier | null
  upstream: string
}

export function createTollBooth(config: TollBoothCoreConfig): TollBoothEngine {
  const defaultAmount = config.defaultInvoiceAmount ?? 1000
  const upstream = config.upstream.replace(/\/$/, '')
  const freeTier = config.freeTier ? new FreeTier(config.freeTier.requestsPerDay) : null

  return {
    freeTier,
    upstream,

    async handle(req: TollBoothRequest): Promise<TollBoothResult> {
      const start = Date.now()
      const path = req.path
      const pricedCost = config.pricing[path]

      // Unpriced routes: pass through unless strictPricing is enabled
      if (pricedCost === undefined && !config.strictPricing) {
        return { action: 'pass', upstream, headers: {} }
      }

      // Effective cost: explicit pricing, or defaultInvoiceAmount when strictPricing
      const cost = pricedCost ?? defaultAmount

      // Check for L402 Authorisation header
      const authHeader = req.headers['authorization'] ?? req.headers['Authorization']
      if (authHeader?.startsWith('L402 ')) {
        const result = handleL402Auth(authHeader, config.rootKey, config.storage, cost, defaultAmount)
        if (result.authorised) {
          if (result.creditedAmount) {
            config.onPayment?.({
              timestamp: new Date().toISOString(),
              paymentHash: result.paymentHash!,
              amountSats: result.creditedAmount,
            })
          }
          config.onRequest?.({
            timestamp: new Date().toISOString(),
            endpoint: path,
            satsDeducted: cost,
            remainingBalance: result.remaining,
            latencyMs: Date.now() - start,
            authenticated: true,
            clientIp: req.ip,
          })
          return {
            action: 'proxy',
            upstream,
            headers: { 'X-Credit-Balance': String(result.remaining) },
            creditBalance: result.remaining,
          }
        }
        // Fall through to issue a new challenge if authorisation failed
      }

      // Check free tier
      if (freeTier) {
        const check = freeTier.check(req.ip)
        if (check.allowed) {
          config.onRequest?.({
            timestamp: new Date().toISOString(),
            endpoint: path,
            satsDeducted: 0,
            remainingBalance: 0,
            latencyMs: Date.now() - start,
            authenticated: false,
            clientIp: req.ip,
          })
          return {
            action: 'proxy',
            upstream,
            headers: { 'X-Free-Remaining': String(check.remaining) },
            freeRemaining: check.remaining,
          }
        }
      }

      // Issue L402 challenge
      let paymentHash: string
      let bolt11: string | undefined

      if (config.backend) {
        const invoice = await config.backend.createInvoice(
          defaultAmount,
          `toll-booth: ${defaultAmount} sats credit`,
        )
        paymentHash = invoice.paymentHash
        bolt11 = invoice.bolt11
      } else {
        // Cashu-only mode: synthetic payment hash (no Lightning invoice)
        paymentHash = randomBytes(32).toString('hex')
      }

      const macaroon = mintMacaroon(config.rootKey, paymentHash, defaultAmount)
      const statusToken = randomBytes(32).toString('hex')

      // Store invoice for payment page (bolt11 is empty in Cashu-only mode)
      config.storage.storeInvoice(paymentHash, bolt11 ?? '', defaultAmount, macaroon, statusToken)

      config.onChallenge?.({
        timestamp: new Date().toISOString(),
        endpoint: path,
        amountSats: defaultAmount,
        clientIp: req.ip,
      })

      const headers: Record<string, string> = bolt11
        ? { 'WWW-Authenticate': `L402 macaroon="${macaroon}", invoice="${bolt11}"`, 'X-Powered-By': 'toll-booth' }
        : { 'WWW-Authenticate': `L402 macaroon="${macaroon}"`, 'X-Powered-By': 'toll-booth' }

      const body: Record<string, unknown> = {
        error: 'Payment required',
        macaroon,
        payment_hash: paymentHash,
        payment_url: `/invoice-status/${paymentHash}?token=${statusToken}`,
        amount_sats: defaultAmount,
      }
      if (bolt11) body.invoice = bolt11

      return {
        action: 'challenge',
        status: 402,
        headers,
        body,
      }
    },
  }
}

function handleL402Auth(
  authHeader: string,
  rootKey: string,
  storage: StorageBackend,
  cost: number,
  defaultAmount: number,
): { authorised: boolean; remaining: number; paymentHash?: string; creditedAmount?: number } {
  try {
    const token = authHeader.slice(5) // Remove "L402 "
    const colonIdx = token.lastIndexOf(':')
    if (colonIdx === -1) return { authorised: false, remaining: 0 }

    const macaroonBase64 = token.slice(0, colonIdx)
    const preimage = token.slice(colonIdx + 1)

    const result = verifyMacaroon(rootKey, macaroonBase64)
    if (!result.valid || !result.paymentHash) return { authorised: false, remaining: 0 }

    // Verify suffix proof:
    // - Lightning path: suffix is the real preimage (sha256(preimage) == payment hash)
    // - Cashu path: suffix matches the settlement secret stored at redemption time
    const settlementSecret = storage.getSettlementSecret(result.paymentHash)
    const hasValidLightningPreimage = isValidLightningPreimage(preimage, result.paymentHash)
    const hasValidSettlementSecret = settlementSecret !== undefined
      && preimage.length === settlementSecret.length
      && timingSafeEqual(Buffer.from(preimage), Buffer.from(settlementSecret))

    if (!hasValidLightningPreimage && !hasValidSettlementSecret) {
      return { authorised: false, remaining: 0 }
    }

    // Check if this payment hash has already been settled (Lightning or Cashu)
    const alreadySettled = storage.isSettled(result.paymentHash)

    let creditedAmount: number | undefined
    if (!alreadySettled) {
      // First-time settlement must be proven with a real preimage hash match.
      if (!hasValidLightningPreimage) return { authorised: false, remaining: 0 }

      // Atomically settle and credit (handles concurrent requests, crash-safe).
      // Store the preimage as settlement secret so subsequent requests can verify
      // via either sha256(preimage)==hash or direct secret comparison.
      const amount = result.creditBalance ?? defaultAmount
      if (storage.settleWithCredit(result.paymentHash, amount, preimage)) {
        creditedAmount = amount
      }
    }

    // Debit credit for this request
    const debit = storage.debit(result.paymentHash, cost)
    if (!debit.success) return { authorised: false, remaining: debit.remaining }

    return { authorised: true, remaining: debit.remaining, paymentHash: result.paymentHash, creditedAmount }
  } catch (err) {
    console.error('[toll-booth] L402 auth error:', err instanceof Error ? err.message : err)
    return { authorised: false, remaining: 0 }
  }
}

function isValidLightningPreimage(preimage: string, paymentHash: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(preimage)) return false
  const computedHash = createHash('sha256')
    .update(Buffer.from(preimage, 'hex'))
    .digest()
  return timingSafeEqual(computedHash, Buffer.from(paymentHash, 'hex'))
}

// src/adapters/hono.ts
import type { Context, MiddlewareHandler } from 'hono'
import type { TollBoothEngine } from '../core/toll-booth.js'
import type { TollBoothRequest } from '../core/types.js'

/**
 * Hono context variables set by the toll-booth auth middleware.
 *
 * Consumers should declare `Hono<TollBoothEnv>` to get typed access
 * to these variables via `c.get()`.
 */
export type TollBoothEnv = {
  Variables: {
    tollBoothAction: 'proxy' | 'pass'
    tollBoothPaymentHash: string | undefined
    tollBoothEstimatedCost: number | undefined
    tollBoothCreditBalance: number | undefined
    tollBoothFreeRemaining: number | undefined
  }
}

export interface HonoTollBoothConfig {
  engine: TollBoothEngine
  /**
   * Custom callback to extract client IP from the Hono context.
   * Use this for platform-specific IP resolution (e.g. Cloudflare's
   * `CF-Connecting-IP`, or `X-Real-IP` behind a trusted reverse proxy).
   * Falls back to `X-Forwarded-For` header if not provided.
   */
  getClientIp?: (c: Context) => string
}

export interface HonoTollBooth {
  authMiddleware: MiddlewareHandler<TollBoothEnv>
  engine: TollBoothEngine
}

/**
 * Creates a Hono middleware that enforces L402 payment gating.
 *
 * On `challenge` results a 402 response is returned with invoice details.
 * On `pass` or `proxy` results, context variables are set and the next
 * handler is called:
 * - `tollBoothAction`: `'proxy'` or `'pass'`
 * - `tollBoothPaymentHash`: payment hash (proxy only)
 * - `tollBoothEstimatedCost`: estimated cost in credits (proxy only)
 * - `tollBoothCreditBalance`: remaining balance (proxy only)
 * - `tollBoothFreeRemaining`: remaining free-tier requests (proxy only)
 */
export function createHonoTollBooth(config: HonoTollBoothConfig): HonoTollBooth {
  const { engine } = config

  const authMiddleware: MiddlewareHandler<TollBoothEnv> = async (c, next) => {
    const req = c.req.raw
    const ip = config.getClientIp?.(c)
      ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
      ?? '0.0.0.0'

    const tollReq: TollBoothRequest = {
      method: req.method,
      path: new URL(req.url).pathname,
      headers: Object.fromEntries(req.headers.entries()),
      ip,
      body: req.body,
    }

    const result = await engine.handle(tollReq)

    if (result.action === 'challenge') {
      return c.json(result.body, result.status as 402, result.headers)
    }

    // 'proxy' or 'pass' — set context variables and continue
    if (result.action === 'proxy') {
      c.set('tollBoothPaymentHash', result.paymentHash)
      c.set('tollBoothEstimatedCost', result.estimatedCost)
      c.set('tollBoothCreditBalance', result.creditBalance)
      c.set('tollBoothFreeRemaining', result.freeRemaining)
    }
    c.set('tollBoothAction', result.action)

    await next()
  }

  return { authMiddleware, engine }
}

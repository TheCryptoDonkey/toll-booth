// src/adapters/web-standard.ts
import type { TollBoothEngine } from '../core/toll-booth.js'
import type { CreateInvoiceDeps } from '../core/create-invoice.js'
import type { CreateInvoiceRequest, NwcPayRequest, CashuRedeemRequest } from '../core/types.js'
import type { InvoiceStatusDeps } from '../core/invoice-status.js'
import { handleCreateInvoice } from '../core/create-invoice.js'
import { handleInvoiceStatus, renderInvoiceStatusHtml } from '../core/invoice-status.js'
import { handleNwcPay } from '../core/nwc-pay.js'
import type { NwcPayDeps } from '../core/nwc-pay.js'
import { handleCashuRedeem } from '../core/cashu-redeem.js'
import type { CashuRedeemDeps } from '../core/cashu-redeem.js'
import { PAYMENT_HASH_RE } from '../core/types.js'

export type WebStandardHandler = (req: Request) => Promise<Response>

// -- Helpers ------------------------------------------------------------------

/**
 * Parses the request body as JSON with a configurable size limit.
 *
 * Checks the `Content-Length` header first for a fast rejection, then reads
 * the body as text and enforces the byte limit before parsing. Returns an
 * empty object on any failure (oversized body, missing body, malformed JSON)
 * so callers behave identically to the previous `.catch(() => ({}))` pattern.
 *
 * @param req      - The incoming request.
 * @param maxBytes - Maximum allowed body size in bytes (default: 64 KiB).
 */
async function safeParseJson<T = Record<string, unknown>>(req: Request, maxBytes = 65_536): Promise<T> {
  // Quick rejection via Content-Length header — avoids reading the body at all
  const contentLength = req.headers.get('content-length')
  if (contentLength !== null && parseInt(contentLength, 10) > maxBytes) {
    return {} as T
  }

  try {
    const text = await req.text()
    if (text.length > maxBytes) {
      return {} as T
    }
    return JSON.parse(text) as T
  } catch {
    return {} as T
  }
}

async function proxyUpstream(upstream: string, req: Request, timeoutMs = 30_000): Promise<Response> {
  const url = new URL(req.url)
  const target = `${upstream}${url.pathname}${url.search}`
  const headers = new Headers(req.headers)
  headers.delete('Authorization')
  headers.delete('Host')

  const init: RequestInit & { duplex?: string } = {
    method: req.method,
    headers,
    signal: AbortSignal.timeout(timeoutMs),
    duplex: 'half',
  }

  // Forward body for non-GET/HEAD requests
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    init.body = req.body
  }

  return fetch(target, init as RequestInit)
}

// -- Middleware ----------------------------------------------------------------

/**
 * Returns a `WebStandardHandler` that enforces L402 payment gating.
 *
 * On `pass` or `proxy` results the request is forwarded to the upstream.
 * On `challenge` a 402 response is returned with invoice details.
 */
export interface WebStandardMiddlewareConfig {
  engine: TollBoothEngine
  upstream: string
  trustProxy?: boolean
  responseHeaders?: Record<string, string>
  /** Timeout in milliseconds for upstream proxy requests (default: 30000). */
  upstreamTimeout?: number
  /**
   * Custom callback to extract client IP from the request.
   * Use this for platform-specific IP resolution (e.g. Cloudflare's
   * `CF-Connecting-IP`, Deno's `connInfo.remoteAddr`).
   * If `freeTier` is enabled, provide either `trustProxy: true` or
   * a `getClientIp` callback for per-client isolation.
   */
  getClientIp?: (req: Request) => string
}

export function createWebStandardMiddleware(
  engineOrConfig: TollBoothEngine | WebStandardMiddlewareConfig,
  upstreamArg?: string,
): WebStandardHandler {
  // Support both old (engine, upstream) and new (config) signatures
  const config: WebStandardMiddlewareConfig = typeof upstreamArg === 'string'
    ? { engine: engineOrConfig as TollBoothEngine, upstream: upstreamArg }
    : engineOrConfig as WebStandardMiddlewareConfig
  const engine = config.engine
  const upstreamBase = config.upstream.replace(/\/$/, '')
  const extraHeaders = config.responseHeaders ?? {}
  const upstreamTimeout = config.upstreamTimeout ?? 30_000

  // Fail closed when free-tier is enabled but all requests would collapse
  // into one shared bucket.
  if (engine.freeTier && !config.trustProxy && !config.getClientIp) {
    throw new Error(
      'freeTier requires either trustProxy: true or getClientIp for the web-standard adapter',
    )
  }

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url)
    const ip = config.getClientIp
      ? config.getClientIp(req)
      : config.trustProxy
        ? req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? req.headers.get('x-real-ip') ?? 'unknown'
        : 'unknown'
    const headers = Object.fromEntries(req.headers.entries())

    const result = await engine.handle({
      method: req.method,
      path: url.pathname,
      headers,
      ip,
      body: req.body,
    })

    if (result.action === 'pass' || result.action === 'proxy') {
      const res = await proxyUpstream(upstreamBase, req, upstreamTimeout)
      const responseHeaders = new Headers(res.headers)
      for (const [key, value] of Object.entries(result.headers)) {
        responseHeaders.set(key, value)
      }
      for (const [key, value] of Object.entries(extraHeaders)) {
        responseHeaders.set(key, value)
      }
      return new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers: responseHeaders,
      })
    }

    // challenge — 402
    const challengeHeaders = { ...result.headers, ...extraHeaders }
    return Response.json(result.body, {
      status: 402,
      headers: challengeHeaders,
    })
  }
}

// -- Invoice status handler ---------------------------------------------------

/**
 * Returns a `WebStandardHandler` that serves invoice status as JSON or HTML.
 *
 * Extracts the payment hash from the last URL path segment and expects
 * a `?token=...` status lookup secret. When `Accept: text/html` is requested,
 * renders the self-service payment page; otherwise returns JSON with
 * `{ paid, preimage }`.
 */
export function createWebStandardInvoiceStatusHandler(
  deps: InvoiceStatusDeps,
): WebStandardHandler {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url)
    const segments = url.pathname.split('/').filter(Boolean)
    const paymentHash = segments[segments.length - 1] ?? ''
    if (!PAYMENT_HASH_RE.test(paymentHash)) {
      return Response.json({ error: 'Invalid payment hash' }, { status: 400 })
    }
    const statusToken = url.searchParams.get('token') ?? undefined
    const accept = req.headers.get('accept') ?? ''

    try {
      if (accept.includes('text/html')) {
        const { html, status } = await renderInvoiceStatusHtml(deps, paymentHash, statusToken)
        return new Response(html, {
          status,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        })
      }

      const result = await handleInvoiceStatus(deps, paymentHash, statusToken)
      if (!result.found) {
        return Response.json({ error: 'Invoice not found' }, { status: 404 })
      }
      return Response.json({ paid: result.paid, preimage: result.preimage, token_suffix: result.tokenSuffix })
    } catch {
      return Response.json({ error: 'Failed to check invoice status' }, { status: 502 })
    }
  }
}

// -- Create invoice handler ---------------------------------------------------

/**
 * Returns a `WebStandardHandler` that creates a new Lightning invoice.
 *
 * Parses the JSON body for an optional `amountSats` field, delegates
 * to the core `handleCreateInvoice`, and returns the result.
 */
export function createWebStandardCreateInvoiceHandler(
  deps: CreateInvoiceDeps,
): WebStandardHandler {
  return async (req: Request): Promise<Response> => {
    const body = await safeParseJson<CreateInvoiceRequest>(req)
    const result = await handleCreateInvoice(deps, body)

    if (!result.success) {
      return Response.json({ error: result.error, tiers: result.tiers }, { status: 400 })
    }

    const d = result.data!
    return Response.json({
      bolt11: d.bolt11,
      payment_hash: d.paymentHash,
      payment_url: d.paymentUrl,
      amount_sats: d.amountSats,
      credit_sats: d.creditSats,
      macaroon: d.macaroon,
      qr_svg: d.qrSvg,
    })
  }
}

// -- NWC handler --------------------------------------------------------------

/**
 * Returns a `WebStandardHandler` that pays a Lightning invoice via NWC.
 *
 * Expects JSON body with `{ nwcUri, bolt11, paymentHash, statusToken }`.
 * Returns the payment preimage on success.
 */
export function createWebStandardNwcHandler(deps: NwcPayDeps): WebStandardHandler {
  return async (req: Request): Promise<Response> => {
    const body = await safeParseJson<NwcPayRequest>(req)
    const result = await handleNwcPay(deps, body)
    if (result.success) {
      return Response.json({ preimage: result.preimage })
    }
    return Response.json({ error: result.error }, { status: result.status })
  }
}

// -- Cashu handler ------------------------------------------------------------

/**
 * Returns a `WebStandardHandler` that redeems a Cashu token as payment.
 *
 * Expects JSON body with `{ token, paymentHash, statusToken }`.
 * Uses durable write-ahead claims for crash-safe redemption.
 */
export function createWebStandardCashuHandler(deps: CashuRedeemDeps): WebStandardHandler {
  return async (req: Request): Promise<Response> => {
    const body = await safeParseJson<CashuRedeemRequest>(req)
    const result = await handleCashuRedeem(deps, body)
    if (result.success) {
      return Response.json({ credited: result.credited, token_suffix: result.tokenSuffix })
    }
    if ('state' in result) {
      return Response.json({ state: result.state, retryAfterMs: result.retryAfterMs }, { status: 202 })
    }
    return Response.json({ error: result.error }, { status: result.status })
  }
}

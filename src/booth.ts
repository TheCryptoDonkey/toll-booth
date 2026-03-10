// src/booth.ts
import type { BoothConfig, EventHandler } from './types.js'
import type { StorageBackend } from './storage/interface.js'
import type { TollBoothEngine } from './core/toll-booth.js'
import type { CreateInvoiceDeps } from './core/create-invoice.js'
import type { InvoiceStatusDeps } from './core/invoice-status.js'
import { createTollBooth } from './core/toll-booth.js'
import { sqliteStorage } from './storage/sqlite.js'
import { StatsCollector } from './stats.js'
import { randomBytes } from 'node:crypto'

import { createHonoMiddleware, createHonoInvoiceStatusHandler, createHonoCreateInvoiceHandler, createHonoNwcHandler, createHonoCashuHandler } from './adapters/hono.js'
import { createExpressMiddleware, createExpressInvoiceStatusHandler, createExpressCreateInvoiceHandler } from './adapters/express.js'
import { createWebStandardMiddleware, createWebStandardInvoiceStatusHandler, createWebStandardCreateInvoiceHandler } from './adapters/web-standard.js'

export type AdapterType = 'hono' | 'express' | 'web-standard'

export interface BoothOptions extends Omit<BoothConfig, 'dbPath'> {
  adapter: AdapterType
  storage?: StorageBackend
}

/**
 * Encapsulates the middleware, invoice-status handler, create-invoice handler,
 * and wallet adapter endpoints with shared internal state.
 *
 * The `adapter` option selects the framework integration:
 * - `'hono'` — Hono middleware and handlers
 * - `'express'` — Express middleware and handlers
 * - `'web-standard'` — Web Standards (Request/Response) handlers
 *
 * ```typescript
 * const booth = new Booth({ adapter: 'hono', ...config })
 * app.get('/invoice-status/:paymentHash', booth.invoiceStatusHandler)
 * app.post('/create-invoice', booth.createInvoiceHandler)
 * app.use('/*', booth.middleware)
 * ```
 */
export class Booth {
  readonly middleware: unknown
  readonly invoiceStatusHandler: unknown
  readonly createInvoiceHandler: unknown
  readonly nwcPayHandler?: unknown
  readonly cashuRedeemHandler?: unknown

  /** Aggregate usage statistics. Resets on restart. */
  readonly stats: StatsCollector

  private readonly storage: StorageBackend
  private readonly engine: TollBoothEngine
  private readonly rootKey: string

  constructor(config: BoothOptions & EventHandler) {
    this.rootKey = config.rootKey ?? randomBytes(32).toString('hex')
    this.storage = config.storage ?? sqliteStorage()
    this.stats = new StatsCollector()
    this.trustProxy = config.trustProxy ?? false

    // Recover any Cashu redemptions that succeeded externally but
    // crashed before the local credit was applied.
    const recovered = this.meter.recoverPendingRedemptions()
    if (recovered > 0) {
      console.error(`[toll-booth] Recovered ${recovered} pending Cashu redemption(s) from previous crash`)
    }
    this.adminToken = config.adminToken

    const defaultAmount = config.defaultInvoiceAmount ?? 1000

    // Wire stats collection while preserving user-provided callbacks
    const userOnPayment = config.onPayment
    const userOnRequest = config.onRequest
    const userOnChallenge = config.onChallenge
    const stats = this.stats

    this.engine = createTollBooth({
      backend: config.backend,
      storage: this.storage,
      pricing: config.pricing,
      upstream: config.upstream,
      defaultInvoiceAmount: defaultAmount,
      rootKey: this.rootKey,
      freeTier: config.freeTier,
      creditTiers: config.creditTiers,
      onPayment: (event) => {
        stats.recordPayment(event)
        userOnPayment?.(event)
      },
      onRequest: (event) => {
        stats.recordRequest(event)
        userOnRequest?.(event)
      },
      onChallenge: (event) => {
        stats.recordChallenge(event)
        userOnChallenge?.(event)
      },
    })

    const createInvoiceDeps: CreateInvoiceDeps = {
      backend: config.backend,
      storage: this.storage,
      rootKey: this.rootKey,
      tiers: config.creditTiers ?? [],
      defaultAmount,
    }

    const invoiceStatusDeps: InvoiceStatusDeps = {
      backend: config.backend,
      storage: this.storage,
      tiers: config.creditTiers,
      nwcEnabled: !!config.nwcPayInvoice,
      cashuEnabled: !!config.redeemCashu,
    }

    const upstream = config.upstream.replace(/\/$/, '')

    switch (config.adapter) {
      case 'hono':
        this.middleware = createHonoMiddleware({ engine: this.engine, upstream })
        this.invoiceStatusHandler = createHonoInvoiceStatusHandler(invoiceStatusDeps)
        this.createInvoiceHandler = createHonoCreateInvoiceHandler(createInvoiceDeps)
        if (config.nwcPayInvoice) {
          this.nwcPayHandler = createHonoNwcHandler(config.nwcPayInvoice)
        }
        if (config.redeemCashu) {
          this.cashuRedeemHandler = createHonoCashuHandler(config.redeemCashu, this.storage)
        }
        break

      case 'express':
        this.middleware = createExpressMiddleware(this.engine, upstream)
        this.invoiceStatusHandler = createExpressInvoiceStatusHandler(invoiceStatusDeps)
        this.createInvoiceHandler = createExpressCreateInvoiceHandler(createInvoiceDeps)
        break

      case 'web-standard':
        this.middleware = createWebStandardMiddleware(this.engine, upstream)
        this.invoiceStatusHandler = createWebStandardInvoiceStatusHandler(invoiceStatusDeps)
        this.createInvoiceHandler = createWebStandardCreateInvoiceHandler(createInvoiceDeps)
        break
    }
  }

  /** Reset free-tier counters for all IPs. */
  resetFreeTier(): void {
    this.engine.freeTier?.reset()
  }

  /**
   * Handler for GET /health — lightweight liveness check.
   * Returns 200 with status, uptime, and database connectivity.
   * No authentication required.
   */
  healthHandler = async (c: Context): Promise<Response> => {
    const dbOk = this.checkDatabase()
    const lnOk = await this.checkLightning()
    const allOk = dbOk && lnOk
    return c.json({
      status: allOk ? 'healthy' : 'degraded',
      upSince: this.stats.snapshot().upSince,
      database: dbOk ? 'ok' : 'unreachable',
      lightning: lnOk ? 'ok' : 'unreachable',
    }, allOk ? 200 : 503)
  }

  /**
   * Remove expired invoices, drained credits, and stale redemption claims.
   * Call periodically (e.g. daily) to prevent unbounded database growth.
   * @param invoiceMaxAgeSecs - Max age for invoices (default: 86400 = 24 hours)
   * @param claimMaxAgeSecs - Max age for orphaned claims (default: 3600 = 1 hour)
   */
  cleanup(invoiceMaxAgeSecs = 86_400, claimMaxAgeSecs = 3_600): {
    invoicesRemoved: number; creditsRemoved: number; staleClaimsRemoved: number
  } {
    const invoicesRemoved = this.invoiceStore.cleanup(invoiceMaxAgeSecs)
    const creditsRemoved = this.meter.cleanupDrained()
    const staleClaimsRemoved = this.meter.cleanupStaleClaims(claimMaxAgeSecs)
    return { invoicesRemoved, creditsRemoved, staleClaimsRemoved }
  }

  close(): void {
    this.storage.close()
  }

  private async checkLightning(): Promise<boolean> {
    try {
      await this.backend.checkInvoice('0'.repeat(64))
      return true
    } catch {
      return false
    }
  }

  private checkDatabase(): boolean {
    try {
      this.db.prepare('SELECT 1').get()
      return true
    } catch {
      return false
    }
  }

  private isAuthorisedAdmin(c: Context): boolean {
    if (this.adminToken) {
      const auth = c.req.header('Authorization')
      if (auth?.startsWith('Bearer ')) {
        return safeEqual(auth.slice(7).trim(), this.adminToken)
      }
      return safeEqual(c.req.header('X-Admin-Token') ?? '', this.adminToken)
    }

    const ip = getTrustedClientIp(c, this.trustProxy)
    return ip !== null && isLoopback(ip)
  }

  private adminErrorMessage(): string {
    if (this.adminToken) {
      return 'Invalid or missing admin token'
    }
    if (!this.trustProxy) {
      return 'Admin endpoints require adminToken or trustProxy=true with a trusted reverse proxy'
    }
    return 'Admin only available from localhost'
  }
}

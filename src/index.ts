// src/index.ts
export { lightningGate } from './middleware.js'
export { mintMacaroon, verifyMacaroon, parseCaveats } from './macaroon.js'
export { CreditMeter } from './meter.js'
export { FreeTier } from './free-tier.js'

export type {
  LightningBackend,
  Invoice,
  InvoiceStatus,
  PricingTable,
  GateConfig,
  PaymentEvent,
  RequestEvent,
} from './types.js'

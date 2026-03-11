# toll-booth

[![MIT licence](https://img.shields.io/badge/licence-MIT-blue.svg)](./package.json)
[![Nostr](https://img.shields.io/badge/Nostr-Zap%20me-purple)](https://primal.net/p/npub1mgvlrnf5hm9yf0n5mf9nqmvarhvxkc6remu5ec3vf8r0txqkuk7su0e7q2)

Embeddable [L402](https://docs.lightning.engineering/the-lightning-network/l402) middleware for JavaScript. Gate any HTTP API behind Lightning payments — no separate proxy, no LND required.

```ts
import express from 'express'
import { Booth } from 'toll-booth'
import { phoenixdBackend } from 'toll-booth/backends/phoenixd'

const app = express()

const booth = new Booth({
  adapter: 'express',
  backend: phoenixdBackend({ url: 'http://localhost:9740', password: 'your-password' }),
  pricing: {
    '/api/route': 2,        // must match the mounted paths the middleware sees
    '/api/isochrone': 5,
    '/api/sources_to_targets': 10,
  },
  freeTier: { requestsPerDay: 10 },
  upstream: 'http://localhost:8002',
  rootKey: process.env.ROOT_KEY, // 32-byte hex key
  dbPath: './toll-booth.db',
  trustProxy: true, // only behind a trusted reverse proxy that sets client IP headers
  strictPricing: true, // reject unpriced routes with 402 instead of passing them through
})

app.get('/invoice-status/:paymentHash', booth.invoiceStatusHandler as any)
app.post('/create-invoice', booth.createInvoiceHandler as any)
app.use('/api/*', booth.middleware as any)
```

## Why not Aperture?

[Aperture](https://github.com/lightninglabs/aperture) is Lightning Labs' production L402 reverse proxy. It's battle-tested and feature-rich. Use it if you can.

toll-booth exists for the cases where Aperture doesn't fit:

| | Aperture | toll-booth |
|---|---|---|
| **Language** | Go binary | TypeScript middleware |
| **Deployment** | Standalone reverse proxy | Embeds in your existing app |
| **Lightning node** | Requires LND | Phoenixd, LND, or CLN |
| **Serverless** | No — long-running process | Yes — Web Standard adapter runs on Cloudflare Workers, Deno, Bun |
| **Configuration** | YAML file | Programmatic (code) |
| **Maturity** | Production (powers Lightning Loop) | Stable |

**Use Aperture** if you run LND and want a proven, standalone proxy with TLS, Tor, Prometheus, and dynamic pricing.

**Use toll-booth** if you want L402 as middleware in a JS app, need Phoenixd support, or deploy to serverless/edge runtimes where a Go binary isn't an option.

## Payment flow

1. Client requests an endpoint without credentials — free tier is checked.
2. Free tier exhausted → **402 response** containing a Lightning invoice and a macaroon.
3. Client pays the invoice and receives a preimage from their wallet.
4. Client sends `Authorization: L402 <macaroon>:<preimage>` on subsequent requests.
5. Each authenticated request deducts from the credit balance encoded in the macaroon.
6. Credits exhausted → new 402 with a fresh invoice.

The `payment_url` returned in a 402 is the canonical invoice-status URL. It now includes a per-invoice lookup secret; treat it like a bearer URL and avoid logging or sharing it.

## Free tier

Each IP address gets a configurable number of free requests per day — no signup required. Once the free allowance is consumed, the client must pay to continue.

`X-Forwarded-For` is only used when `trustProxy: true`. Keep this disabled unless you run behind a trusted reverse proxy that overwrites client IP headers.

## Production checklist

- Set a persistent `rootKey` (32-byte hex), otherwise tokens are invalidated on restart.
- Use a persistent `dbPath` (default: `./toll-booth.db`).
- Enable `strictPricing: true` to prevent unpriced routes from bypassing billing.
- Ensure your `pricing` keys match the paths the middleware actually sees (after mounting).
- Set `trustProxy: true` when behind a reverse proxy, or provide a `getClientIp` callback for per-client free-tier isolation.
- Treat `payment_url` as sensitive because it carries the invoice-status lookup token.
- If you implement `redeemCashu`, make it idempotent for the same `paymentHash`; post-crash recovery cannot be correct otherwise.
- Rate-limit `/create-invoice` at your reverse proxy (nginx, Cloudflare, etc.) — each call creates a real Lightning invoice, so unthrottled access can exhaust node resources.
- For the web-standard adapter, ensure your framework enforces request body size limits (the adapter rejects JSON bodies over 64 KiB by default, but the upstream proxy path streams without limit).
- Upgrade/patch dependencies regularly (`npm audit`).

## Backends

| Backend    | Status      | Notes |
|------------|-------------|-------|
| Phoenixd   | Implemented | Simplest self-hosted option |
| LND        | Implemented | Industry standard |
| CLN        | Implemented | Core Lightning REST API |
| LNbits     | Implemented | Any LNbits instance — self-hosted or hosted |
| Alby (NWC) | Experimental | Disabled by default. The current JSON relay transport is unauthenticated; only enable with `allowInsecureRelay: true` for local testing or a fully trusted relay shim |

## Reference deployment

See [`examples/valhalla-proxy/`](./examples/valhalla-proxy/) for a complete Docker Compose setup that gates a [Valhalla](https://github.com/valhalla/valhalla) routing engine behind toll-booth.

## Support

If you find toll-booth useful, consider sending a tip:

- **Lightning:** `thedonkey@strike.me`
- **Nostr zaps:** `npub1mgvlrnf5hm9yf0n5mf9nqmvarhvxkc6remu5ec3vf8r0txqkuk7su0e7q2`

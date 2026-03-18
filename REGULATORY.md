# Regulatory Compliance Guidance

*This document is reference guidance — not legal advice. Consult qualified legal counsel before making compliance decisions.*

---

## 1. Non-Custodial Classification

toll-booth is authentication middleware, not a payment service. It verifies that a client has paid a Lightning invoice (or redeemed Cashu ecash) and grants API access credits accordingly. It never holds, controls, or transmits funds on behalf of any party.

**Fund flow:** client wallet → operator's Lightning node. toll-booth never touches funds. The operator's Lightning backend (Phoenixd, LND, CLN, LNbits, or NWC) handles all invoice creation and settlement. toll-booth only observes payment status.

**Credit balances** are API quota metadata — not redeemable, not transferable, not refundable. They represent prepaid access to a specific API endpoint and cannot be converted back to currency, moved between accounts, or withdrawn. They are not stored monetary value.

### Regulatory references

- **FinCEN FIN-2019-G001** (US): Non-custodial software that never holds or controls funds is generally not a money transmitter. toll-booth falls into the "software provider" category — it provides tools that others use to accept payments, but does not itself accept, transmit, or hold value.
- **UK PSR 2017**: toll-booth is not a payment institution — it performs no fund holding, no payment initiation, and no payment execution. The operator's Lightning node is the payment infrastructure; toll-booth is middleware that reads payment status.
- **EU MiCA** (Markets in Crypto-Assets Regulation): toll-booth is not a Crypto-Asset Service Provider (CASP) — it performs no custody, no exchange, and no transfer of crypto-assets on behalf of clients.

### What would change this assessment

| Change | Regulatory impact |
|---|---|
| toll-booth holding funds in escrow or custody | Likely money transmitter / payment institution classification |
| Minting or issuing tokens with monetary value | Potential e-money or EMT classification |
| Offering refunds of credits for currency | Credits become stored monetary value |
| Making credits transferable between users | Credits become a medium of exchange |
| Operating a Lightning node as a service for third parties | Potential money transmission / payment service classification |

---

## 2. Data Protection (GDPR)

### What toll-booth stores

- Payment hashes (invoice identifiers — not linked to personal identity)
- One-way hashed IPs (SHA-256 with daily-rotating salt)
- Credit balances (keyed by payment hash)
- Settlement markers (Cashu claim status)

### What toll-booth does NOT store

- Names, emails, or accounts
- Raw IP addresses
- Device fingerprints
- Wallet addresses linked to identities
- Browser user agents or session cookies

### IP hashing approach

Client IPs are hashed with SHA-256 using a daily-rotating salt before any in-memory storage. The hash is one-way — it cannot be reversed to recover the original IP address. Hashed IPs are used solely for free-tier rate limiting and are automatically pruned after 24 hours when the salt rotates. See [docs/security.md](docs/security.md) for implementation details.

### Lawful basis for IP hash processing

Legitimate interest (Article 6(1)(f) GDPR): rate limiting for free-tier access. The proportionality argument is strong:

- **Minimal data** — only a one-way hash, not the IP itself
- **Daily rotation** — the salt changes every 24 hours, rendering older hashes unlinkable
- **Automatic deletion** — pruned when the salt rotates
- **No re-identification possible** — the hash cannot be reversed or cross-referenced

### Subject access requests

toll-booth's IP hashes are irreversible. The data cannot be linked back to an identifiable natural person. This means toll-booth cannot satisfy a subject access request because it cannot identify which records belong to a given data subject — which is a privacy advantage, not a deficiency. There is no personal data to disclose, rectify, or erase.

This aligns with GDPR Recital 26: data that cannot be attributed to an identified or identifiable natural person is not personal data.

### Operator note

If the operator's upstream API collects PII (names, emails, location data), or if the operator's reverse proxy logs raw IP addresses, those are the **operator's** GDPR obligations — not toll-booth's. toll-booth's privacy-by-design architecture does not extend to the operator's own infrastructure choices.

---

## 3. Geo-Fencing and Sanctions

Operators may need to block requests from sanctioned jurisdictions to comply with OFAC (US), OFSI (UK), or EU consolidated sanctions lists.

### Configuration

toll-booth provides an `OFAC_SANCTIONED` constant covering US Treasury OFAC fully-sanctioned jurisdictions:

```typescript
import { createBooth, OFAC_SANCTIONED } from '@forgesworn/toll-booth'

const booth = createBooth({
  blockedCountries: OFAC_SANCTIONED,
  // ...
})
```

> **Important:** `OFAC_SANCTIONED` covers US OFAC sanctions only. Operators subject to UK OFSI or EU sanctions must extend the list with additional jurisdictions. For example, to add Belarus (under EU comprehensive sanctions):
>
> ```typescript
> blockedCountries: [...OFAC_SANCTIONED, 'BY']
> ```

The constant is a point-in-time snapshot at the time of release. Operators must verify against the live sanctions lists and not rely solely on this constant being current:

- **US OFAC:** <https://ofac.treasury.gov/sanctions-programs-and-country-information>
- **UK OFSI:** <https://www.gov.uk/government/publications/financial-sanctions-consolidated-list-of-targets>
- **EU:** <https://data.europa.eu/data/datasets/consolidated-list-of-persons-groups-and-entities-subject-to-eu-financial-sanctions>

### Sub-national sanctions limitation

ISO 3166-1 alpha-2 operates at the country level only. Sub-national sanctions (e.g. Crimea, Donetsk, Luhansk within Ukraine) cannot be distinguished by country code. Operators with sub-national sanctions obligations will need additional compliance measures beyond toll-booth's geo-fencing.

### Country header setup

toll-booth reads the client's country from an HTTP header set by the operator's reverse proxy or CDN. The default header is `CF-IPCountry` (Cloudflare).

| Provider | Header | Configuration |
|---|---|---|
| **Cloudflare** | `CF-IPCountry` | Automatic — no configuration needed (default) |
| **nginx + GeoIP2** | `X-Country-Code` | `proxy_set_header X-Country-Code $geoip2_data_country_code;` with `countryHeader: 'X-Country-Code'` |
| **Caddy + GeoIP** | `X-Country-Code` | Use the Caddy GeoIP module with `countryHeader: 'X-Country-Code'` |

### Disclaimer

Geo-fencing is one layer of a sanctions compliance programme, not a complete solution. IP-based blocking can be circumvented by VPNs, proxies, and Tor. Operators with sanctions obligations should treat geo-fencing as a reasonable technical measure alongside other compliance controls, and consult qualified counsel for their specific requirements.

---

## 4. Cashu Acceptance

toll-booth accepts Cashu ecash tokens via the `xcashu` payment rail and the `redeemCashu` callback. Both are entirely optional — operators who do not configure them have zero Cashu exposure.

### toll-booth's role

toll-booth is a **client/acceptor** of Cashu tokens, not a **mint/issuer**. When a client presents a Cashu token, toll-booth swaps the proofs at the operator's configured mint(s) and credits the API account. toll-booth does not create, issue, or manage ecash tokens.

### Where the regulatory risk sits

The primary regulatory risk in the Cashu chain sits with the **mint operator**. Cashu mints issue bearer ecash tokens that may be classified as Electronic Money Tokens (EMTs) under EU MiCA, potentially requiring Electronic Money Institution (EMI) or credit institution authorisation. toll-booth, as a token acceptor, does not bear this classification risk.

### Operator guidance

- Assess the regulatory status of any Cashu mint you configure before enabling Cashu acceptance
- Consider whether the mint operator holds (or is seeking) the appropriate authorisation in your jurisdiction
- The xcashu rail and redeemCashu callback are entirely opt-in — omitting them from your configuration eliminates all Cashu-related regulatory considerations

### MiCA transition deadline

**1 July 2026** — all pre-existing crypto-asset service providers operating in the EU must be fully authorised under MiCA. This deadline applies to Cashu mint operators, not to toll-booth operators who merely accept tokens. However, operators should be aware that mints operating without authorisation after this date may face enforcement action, which could affect token redeemability.

---

## 5. Operator Responsibilities

toll-booth provides privacy-by-design architecture and sanctions compliance tooling, but the operator — as the entity deploying the service and accepting payment — bears the regulatory obligations.

| Responsibility | toll-booth (the tool) | Operator (the deployer) |
|---|---|---|
| Non-custodial architecture | Provided | — |
| Privacy-by-design (hashed IPs, no PII) | Provided | — |
| Geo-fencing capability | Provided (opt-in) | Decides whether and what to block |
| Lightning node operation | — | Operator's infrastructure |
| Accepting payment for API access | — | Operator is the merchant |
| GDPR for upstream API data | — | Operator's obligation |
| Choosing Cashu mints | — | Operator's risk assessment |
| AML/KYC (if required by jurisdiction) | — | Operator's programme |
| Tax reporting on income | — | Operator's obligation |

### Before you deploy

- [ ] Identify which jurisdictions your users are in
- [ ] Assess whether your volume or activity triggers local registration requirements
- [ ] If serving US users: review FinCEN MSB definitions (likely exempt if non-custodial service sale)
- [ ] If serving EU users: confirm you are not providing MiCA-defined crypto-asset services
- [ ] If enabling Cashu: assess your mint's regulatory status
- [ ] Consider enabling `blockedCountries` for sanctioned jurisdictions
- [ ] If your upstream API collects PII: ensure your own GDPR compliance
- [ ] Consult qualified legal counsel for your specific circumstances

---

## Cross-references

- [docs/security.md](docs/security.md) — IP hashing implementation, macaroon security, storage model
- [docs/deployment.md](docs/deployment.md) — Reverse proxy setup, Docker Compose, serverless deployment

For the client-side perspective, see [402-mcp REGULATORY.md](https://github.com/forgesworn/402-mcp/blob/main/REGULATORY.md).

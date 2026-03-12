# sats-for-laughs

A joke API gated by Lightning payments, powered by [toll-booth](https://github.com/TheCryptoDonkey/toll-booth).

Pay 10 sats, get a joke about bitcoin, lightning, nostr, freedom tech, meshtastic, or Handshake.

## Quick start

1. Copy `.env.example` to `.env` and fill in your Phoenixd credentials
2. `docker compose up -d`

## Local development

```bash
npm install
MOCK=true npm start
```

## Regenerating jokes

Requires an OpenAI API key:

```bash
OPENAI_API_KEY=sk-... npm run generate-jokes
```

## API

- `GET /api/joke` - random joke (1 free per day, then 10 sats)
- `GET /api/joke?topic=nostr` - joke on a specific topic
- `POST /create-invoice` - get a Lightning invoice
- `GET /invoice-status/:paymentHash` - check payment status

Topics: bitcoin, lightning, nostr, freedom tech, meshtastic, handshake

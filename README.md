# bot-sdk — Client SDKs for the Chasky Bot API

**Status: specification. No code yet, in any language.**

Monorepo for the SDKs a bot author installs to talk to the Chasky Bot API —
filling the role `telegraf` and `python-telegram-bot` fill for Telegram.

It deliberately lives **outside** `backend-api-go`: the SDD scoped the external
consumer out of the server repo, and pulling it in would contaminate the API with
decisions that belong to each bot author.

## The three SDKs

| Delivery | Language | Package | Status |
|---|---|---|---|
| 1 | TypeScript | `@chasky/bot` | [`js/`](js/) — empty |
| 2 | Go | `github.com/chaskyapp/bot-sdk/go` | [`go/`](go/) — empty |
| 3 | Python | `chasky-bot` | [`python/`](python/) — empty |

The order is TypeScript → Go → Python. The reason is in §5 of the contract: **a
conformance suite proves nothing with a single consumer**, and Go is the cheapest
second port because the team already writes it and `pepibot` already exists.

## Where to start

- **[docs/00-spec.md](docs/00-spec.md)** — the contract: purpose, surface,
  guaranteed and delegated semantics, identifiers, errors and redaction,
  decisions, and requests to the server.
- **[docs/01-organizacion.md](docs/01-organizacion.md)** — how that contract
  survives three implementations without drifting: layout, what is invariant and
  what is idiomatic, conformance suite, versioning, work order.
- **[conformance/](conformance/)** — the suite that turns the guarantees into
  failing tests. It gets written **before** any SDK.

> **Note:** `docs/` is currently written in Spanish. Everything published —code,
> comments, error messages, these READMEs— is English. The specs get translated
> once the open decisions close (D12).

## The three things that matter most

1. **One process per bot, and starting up displaces whoever was there.** Since
   2026-09-08 the server returns `409 CONFLICT_POLLING`, and it is the **old**
   poll that dies. The SDK stops on a `409` and **never retries**: retrying puts
   two instances into an eviction war. Losing the poll does not lose messages.
2. **The offset always advances**, even when the handler fails. It is a read
   cursor, not a business acknowledgement.
3. **The token travels in the path** and leaks into logs through the transport.
   Every error leaving the SDK is redacted.

## Before writing code

**Six decisions are still open** in §12 of the contract. None of them blocks any
more: D6 —the deduplication strategy— was the blocking one and closed on
2026-09-08, verified against the server code. It resolves to a single integer
threshold, not a data structure.

Packages are `@chasky/bot` and `@chasky/botsmith` on npm (scope confirmed
available), and the same standard —the `chasky` identity plus the role in one
word— carries over to Go and PyPI.

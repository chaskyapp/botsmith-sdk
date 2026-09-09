# botsmith-sdk — Client SDKs for the Chasky Bot API

**Status: specification. No code yet, in any language.**

Monorepo for the SDKs a bot author installs to talk to the Chasky Bot API —
filling the role `telegraf` and `python-telegram-bot` fill for Telegram.

It deliberately lives **outside** `backend-api-go`: the SDD scoped the external
consumer out of the server repo, and pulling it in would contaminate the API with
decisions that belong to each bot author.

## The three SDKs

| Delivery | Language | Package | Status |
|---|---|---|---|
| 1 | TypeScript | `@chasky/botsmith` | [`js/`](js/) — runtime done, 11/11 conformance |
| 2 | Go | `github.com/chaskyapp/botsmith-sdk/go` | [`go/`](go/) — implemented, 11/11 conformance |
| 3 | Python | `chasky-botsmith` | [`python/`](python/) — empty |

The order is TypeScript → Go → Python. The reason is in §5 of the contract: **a
conformance suite proves nothing with a single consumer**, and Go is the cheapest
second port because the team already writes it and `pepibot` already exists.

## Where to start

- **[docs/00-spec.md](docs/00-spec.md)** — the contract: purpose, surface,
  guaranteed and delegated semantics, identifiers, errors and redaction,
  decisions, and requests to the server.
- **[docs/01-organization.md](docs/01-organization.md)** — how that contract
  survives three implementations without drifting: layout, what is invariant and
  what is idiomatic, conformance suite, versioning, work order.
- **[conformance/](conformance/)** — the suite that turns the guarantees into
  failing tests. It gets written **before** any SDK.

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

**All twelve decisions in §12 of the contract are resolved.** The last five closed
on 2026-09-08. The only item left is executing D12 — translating `docs/` to
English — which blocks no code.

Worth knowing before reading the contract: deduplication and the poll offset are
**the same single integer** (`offset == lastSeen + 1`), verified against the
server code. The SDK keeps one number, not a data structure.

Each language ships **one artifact with two entrypoints** — the bot runtime at the
root, management under `/management`:

| | Runtime | Management |
|---|---|---|
| npm | `@chasky/botsmith` | `@chasky/botsmith/management` |
| Go | `.../botsmith-sdk/go` | `.../botsmith-sdk/go/management` |
| PyPI | `chasky_botsmith` | `chasky_botsmith.management` |

Sharing an artifact does not make them one thing: they authenticate differently,
use incompatible envelopes, and a `409` means the opposite on each. Requirements
R-A through R-D in §6 of the contract are what keep them apart — separate
constructors, separate error types, and no import from runtime into management.

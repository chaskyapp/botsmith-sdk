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
| 1 | TypeScript | `@chasky/botsmith` | [`js/`](js/) — 15/15 conformance |
| 2 | Go | `.../botsmith-sdk/go` | [`go/`](go/) — 15/15 conformance |
| 3 | Python | `chasky-botsmith` | [`python/`](python/) — 15/15 conformance |

## Administration is a separate package, on purpose

The BotSmith admin surface (`/bot-management`) sits behind Chasky's **global API
secret gate**, so calling it needs `X-Secret` — the platform's own secret, which
no third party has or should have. The runtime's routes are marked public
precisely so that a bot token is the only credential an external author needs.

So the admin client is not part of the SDK a bot author installs:

| | Bot author installs | Chasky's own BFF installs |
|---|---|---|
| npm | `@chasky/botsmith` | `@chasky/botsmith-admin` |
| Go | `.../botsmith-sdk/go` | `.../botsmith-sdk/go/admin` |
| PyPI | `chasky-botsmith` | `chasky-botsmith-admin` |

A leaked bot token lets someone post as that one bot: bad, bounded, closed by
rotating it. A leaked platform secret opens every non-public route on the API.
Shipping both in one artifact would have put a surface its own audience cannot
use inside the package they install.

**This split is a consequence of the credential, not a permanent shape.**
[`docs/02-developer-api.md`](docs/02-developer-api.md) proposes a new
`/developer/…` surface with a per-developer `x-chasky-dev-secret: sk_…`, shaped
for code rather than for a conversation — creating a bot becomes one call
instead of four chained ones. When that ships, a third party can manage their
own bots with an ordinary public package, and it is worth asking whether the
admin client still has a caller at all.

All three pass the same eleven cases. The order was TypeScript → Go → Python, for
the reason in §5 of the contract: **a conformance suite proves nothing with a
single consumer**, and Go was the cheapest second port because the team already
writes it and `pepibot` already existed.

Each runner is shaped like its ecosystem — a CLI, `go test`, `unittest` — and each
one carries a guard proving it can fail, because a runner that has never failed a
case is not a tested runner.

## Where to start

- **[docs/00-spec.md](docs/00-spec.md)** — the contract: purpose, surface,
  guaranteed and delegated semantics, identifiers, errors and redaction,
  decisions, and requests to the server.
- **[docs/01-organization.md](docs/01-organization.md)** — how that contract
  survives three implementations without drifting: layout, what is invariant and
  what is idiomatic, conformance suite, versioning, work order.
- **[conformance/](conformance/)** — the suite that turns the guarantees into
  failing tests. It gets written **before** any SDK.

## Smoke tests

Each SDK has one, and they all read a single `.env` in this directory:

```bash
cp .env.example .env    # then fill in the token, never export it on a command line
```

| | Command |
|---|---|
| TypeScript | `cd js && npm run smoke` · `npm run smoke:admin` |
| Go | `cd go && go run ./cmd/smoke` · `go run ./cmd/smoke-admin` |
| Python | `cd python && .venv/bin/python smoke.py` · `smoke_admin.py` |

The runtime smokes stand in for a **third-party bot author**: they use only what
such an author has, a bot token. The admin smokes stand in for **Chasky's own
BFF** — they authenticate with the platform secret, so they are not a
third-party scenario at all.

The admin smokes are **read-only by default**. Their commands create bots, rotate
credentials and reveal tokens against real data, so writes sit behind an explicit
`--allow-writes`, and even that only sends `/help`.

## Running conformance

| | Command |
|---|---|
| TypeScript | `cd js && npm run conformance` |
| Go | `cd go && go test ./conformance/ -count=1` |
| Python | `cd python && .venv/bin/python -m unittest conformance.test_conformance` |

`-count=1` matters for Go: its test cache does not hash the shared case files,
so without it a changed case can report `ok (cached)` having run nothing.

Conformance proves an SDK against a fake that answers what the cases declare.
The smoke tests prove the other half: that the cases describe the **real**
server. A case written from a misreading of the spec passes conformance and
fails here.

**All three have been run against a live server (2026-09-09) and print the same
wire shape** — same `chat.id` with its doubled `bot:` prefix intact, same types
on every field, same reading of `date` as seconds. Only `update_id` and
`message_id` differ, because they were different messages. Three independent
mappings agreeing against the real server is what the conformance suite alone
could not establish.

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

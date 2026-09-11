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
| 1 | TypeScript | `@chasky/botsmith` | [`js/`](js/) — 21/21 conformance |
| 2 | Go | `.../botsmith-sdk/go` | [`go/`](go/) — 21/21 conformance |
| 3 | Python | `chasky-botsmith` | [`python/`](python/) — 21/21 conformance |

## Administration is a separate package, on purpose

The BotSmith admin surface (`/bot-management`) takes a credential that
**administers** bots — a developer key (`sk_…`) or a human session, exactly one.
Whoever holds it can create bots, rotate their tokens and point their webhooks
elsewhere. A bot author needs none of that: a bot token is the only credential
the runtime asks for.

So the admin client is not part of the SDK a bot author installs:

| | Bot author installs | Whoever administers bots installs |
|---|---|---|
| npm | `@chasky/botsmith` | `@chasky/botsmith-admin` |
| Go | `.../botsmith-sdk/go` | `.../botsmith-sdk/go/admin` |
| PyPI | `chasky-botsmith` | `chasky-botsmith-admin` |

A leaked bot token lets someone post as that one bot: bad, bounded, closed by
rotating it. A leaked developer key administers every bot its owner has —
recoverable by revoking it, but not the same incident.
Shipping both in one artifact would have put a surface its own audience cannot
use inside the package they install.

**This split is a consequence of the credential, not a permanent shape.**
[`docs/02-developer-api.md`](docs/02-developer-api.md) proposes giving
`/bot-management` its own middleware and a per-developer
`x-chasky-dev-secret: sk_…` — the same `IsPublic`-plus-own-middleware pattern the
bot runtime already uses. When that ships the admin client becomes an ordinary
public package for third parties, and this split reopens on purpose.

All three pass the same 21 cases. The order was TypeScript → Go → Python, for
the reason in §5 of the contract: **a conformance suite proves nothing with a
single consumer**, and Go was the cheapest second port because the team already
writes it.

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
- **[conformance/](conformance/)** — 21 shared cases that turn the guarantees
  into failing tests. They get written **before** any SDK, and every guarantee in
  the contract has at least one.

## Running conformance

| | Command |
|---|---|
| TypeScript | `cd js && npm run conformance` |
| Go | `cd go && go test ./conformance/ -count=1` |
| Python | `cd python && .venv/bin/python -m unittest conformance.test_conformance` |

`-count=1` matters for Go: its test cache does not hash the shared case files,
so without it a changed case can report `ok (cached)` having run nothing.

Conformance proves an SDK against a fake that answers what the cases declare.
Whether the cases describe the **real** server is checked outside this
repository, against a running instance: the library ships no examples and no
smoke programs. A case written from a misreading of the spec passes conformance
and fails there.

**All three were run against a live server (2026-09-09) and printed the same
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

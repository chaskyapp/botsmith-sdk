# botsmith-sdk — Client SDKs for the Chasky Bot API

**Status: implemented in TypeScript, Go and Python — 26/26 conformance each.**

Monorepo for the SDKs a bot author installs to talk to the Chasky Bot API —
filling the role `telegraf` and `python-telegram-bot` fill for Telegram.

It deliberately lives **outside** `backend-api-go`: the SDD scoped the external
consumer out of the server repo, and pulling it in would contaminate the API with
decisions that belong to each bot author.

## The three SDKs

| Delivery | Language | Package | Status |
|---|---|---|---|
| 1 | TypeScript | `@chasky/botsmith-sdk` | [`js/`](js/) — 26/26 conformance |
| 2 | Go | `.../botsmith-sdk/go` | [`go/`](go/) — 26/26 conformance |
| 3 | Python | `chasky-botsmith-sdk` | [`python/`](python/) — 26/26 conformance |

## Administration is a separate package, on purpose

The BotSmith admin surface (`/bot-management`) takes a credential that
**administers** bots — a developer key (`sk_…`) or a human session, exactly one.
Whoever holds it can create bots, rotate their tokens and point their webhooks
elsewhere. A bot author needs none of that: a bot token is the only credential
the runtime asks for.

So the admin client is not part of the SDK a bot author installs:

| | Bot author installs | Whoever administers bots installs |
|---|---|---|
| npm | `@chasky/botsmith-sdk` | `@chasky/botsmith-sdk-admin` |
| Go | `.../botsmith-sdk/go` | `.../botsmith-sdk/go/admin` |
| PyPI | `chasky-botsmith-sdk` | `chasky-botsmith-sdk-admin` |

A leaked bot token lets someone post as that one bot: bad, bounded, closed by
rotating it. A leaked developer key administers every bot its owner has —
recoverable by revoking it, but not the same incident.
Shipping both in one artifact would have put a surface its own audience cannot
use inside the package they install.

**The split outlived the reason it was made for.** It started as a consequence of
the credential: before developer keys, `/bot-management` sat behind the platform's
own secret. Server delta 22 gave every developer their own `sk_…` key, which
reopened the question as [`docs/02-developer-api.md`](docs/02-developer-api.md)
planned, and it closed with the packages still apart (D14 in §12 of the
contract). What keeps them apart now is cadence: administration follows the
server's deltas, the runtime does not, and a change in one should never force a
release of the other.

All three pass the same 26 cases. The order was TypeScript → Go → Python, for
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
- **[conformance/](conformance/)** — 26 shared cases that turn the guarantees
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

For bots in group chats — read modes, mentions, `my_chat_member` and rate
limits — see [Groups](#groups) below.

## The three things that matter most

1. **One process per bot, and starting up displaces whoever was there.** Since
   2026-09-08 the server returns `409 CONFLICT_POLLING`, and it is the **old**
   poll that dies. The SDK stops on a `409` and **never retries**: retrying puts
   two instances into an eviction war. Losing the poll does not lose messages.
2. **The offset always advances**, even when the handler fails. It is a read
   cursor, not a business acknowledgement.
3. **The token travels in the path** and leaks into logs through the transport.
   Every error leaving the SDK is redacted.

## Groups

A bot can live in group chats, not only in the 1:1 a person opens with it.

**Who puts it there.** Its owner allows it first, from administration: the
`allowgroups` command (`disallowgroups` undoes it and also takes the bot out of
every group it is in). Then a **group admin** adds it, and chooses two things
for that group:

| Choice | Values | What it means |
|---|---|---|
| Read mode | `all`, `mentions` | Every message from a person, or only the ones that mention the bot, reply to one of its messages, or are a command (`/start`, or `/start@its_username` — never `/start@another_bot`) |
| History | `full`, `since_join` | Whether it may see what was said before it joined (the history method arrives later) |

At most 10 bots per group. Messages from bots never reach a bot, in a group or
in a 1:1, so two bots cannot answer each other forever.

**What an update looks like in a group.** The same five fields as a 1:1, plus
these (named as in TypeScript; Go and Python use their own casing):

| Field | |
|---|---|
| `chat.type` | `"group"`, with `chat.title` |
| `from.isBot` | `false` on what people write |
| `mentions` | the **people** the message mentions, `{userId, name}`; absent when none |
| `mentioned` | `true` only when the message mentions **this** bot |
| `replyToMessage` | the message being answered: `{messageId, from, text}`, text cut at 500 |

When the bot is added, has its modes changed, or leaves a group, it receives a
`my_chat_member` update, with no message: who did it, and the old and new
`{status, readMode, historyMode}`. To see it, register the catch-all handler,
which runs for every update — including kinds this version of the SDK has no
type for yet, which arrive with their raw form instead of being dropped (G10).

**Commands in a group.** A command handler runs for `/start` and for
`/start@its_username` (any case), and never for `/start@another_bot` or a bare
`/start@`: those reach the text handler as plain text, because in read mode
`all` the server delivers them to every bot in the group. The SDK learns its
own username from `getMe`, once, the first time a suffixed command arrives
(G13).

**Sending to a group.** The same `sendMessage`, to the group's chat id. To
mention someone, pass `mentions` as `{ "<name as it appears in your text>":
"<user id>" }` — only active people of the group, at most 20. The SDK never
sends the field empty (G12).

| | TypeScript | Go | Python |
|---|---|---|---|
| Every update | `bot.on("update", fn)` | `bot.HandleUpdate(fn)` | `@bot.on_update` |
| Membership change | `update.myChatMember` | `update.MyChatMember` | `update.my_chat_member` |
| Reply with mentions | `ctx.reply(text, { mentions })` | `ev.ReplyWith(ctx, text, chaskybot.ReplyOptions{Mentions: m})` | `event.reply(text, mentions=...)` |
| Allow groups | command `allowgroups`, `BotView.allowGroups` | `admin.CommandAllowGroups`, `BotView.AllowGroups` | command `"allowgroups"`, `BotView.allow_groups` |

**New errors**, all business errors returned to the caller (the bot lives on):

| Code | Description | When |
|---|---|---|
| 403 | `BOT_NOT_A_MEMBER` | The group exists but this bot is not an active member (it was removed) |
| 400 | `MENTION_NOT_A_MEMBER` | A mention is not an active person of the chat, or is a bot |
| 400 | `TOO_MANY_MENTIONS` | More than 20 mentions in one message |
| 400 | `REPLY_TO_MESSAGE_NOT_FOUND` | Also when replying to another bot's message |

Each SDK names these descriptions as constants. The SDK itself still decides
only by code (§10.1 of the contract); the constants are for the author's own
handling.

**Rate limits.** Per bot: 30 requests per second in total (`getUpdates` does not
count), 1 message per second per chat with a burst of 5, and 20 per minute per
group. Over the limit the server answers `429 TOO_MANY_REQUESTS` with
`retry_after` in seconds, and writes nothing. The SDK waits at least that long
and resends the same message with the **same** `Idempotency-Key`, so the retry
can never post twice; a `429` never stops the bot (G11). A send that is still
refused after the SDK's attempts reaches the author as an error carrying the
wait the server asked for.

## Decisions

**All fourteen decisions in §12 of the contract are closed.** Worth knowing
before reading it: deduplication and the poll offset are **the same single
integer** (`offset == lastSeen + 1`), verified against the server code. The SDK
keeps one number, not a data structure.

Runtime and administration are separate packages in npm and PyPI and a
subpackage of the one module in Go (D14, table above). Even where they ship
together they are not one thing: they authenticate differently, use incompatible
envelopes, and a `409` means the opposite on each. Requirements R-A through R-D
in §6 of the contract keep them apart — separate constructors, separate error
types, and no import from runtime into administration.

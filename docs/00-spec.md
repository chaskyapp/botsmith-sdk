# Chasky Bot API Client SDK — Specification

Status: **specification. No code yet.** Every decision in §12 is closed, so
implementation can start; §6 of `01-organization.md` has the work order.

Last updated: 2026-09-09.
Reference server: `backend-api-go`, branch `cc-jose-nieto/botapi`.
Field evidence: `~/Desktop/pepibot/main.go` (554 lines of Go, stdlib only), a
client that runs against Chasky and Telegram simultaneously to compare the two
contracts.

---

## 1. Purpose

A bot author who wants to talk to Chasky today has to write, by hand and before
their first line of actual logic:

- the long-poll loop and its retry,
- the `offset` arithmetic,
- deduplication by `update_id`,
- generating and reusing the `Idempotency-Key`,
- redacting the token out of transport errors,
- clamping `limit`/`timeout` to the server's maximums,
- and mapping an `{ok, result}` envelope to typed errors.

That is pepibot's 554 lines **before answering a single message**. All of it is
infrastructure, not product: every author will rewrite the same thing, and every
one of them will get the same five details wrong.

The SDK exists so the author writes only this:

> "when a text message arrives, reply X."

That is exactly the job `telegraf` and `python-telegram-bot` do for Telegram.

### Non-purpose

- **It is not a Telegram client.** No portability is promised for code written
  against Telegram (§4).
- **It does not live in `backend-api-go`.** The SDD scoped the external consumer
  out of the server repo deliberately: pulling it in would contaminate the API
  with decisions that belong to each bot author.
- **It invents no guarantee the server does not give.** Everything the server
  does not promise is delegated explicitly and in writing (§8).

---

## 2. The server as it stands today

What follows is descriptive, not aspirational: it is the contract the SDK is
written against.

### 2.1 Token surface (Bot API)

Local base URL: `http://localhost:54250/api/v1` — the whole server lives under
`/api/v1` because nexus prepends `Settings.PathPrefix`.

```
POST <base>/bot<TOKEN>/getMe
POST <base>/bot<TOKEN>/getUpdates
POST <base>/bot<TOKEN>/sendMessage
POST <base>/bot<TOKEN>/sendChatAction
```

The token travels **in the path** and is the **only** credential. These routes
are public: they require neither `x-secret` nor a session. Token format:
`bot:{uuid}:{64-hex-secret}` — split it on the **last** `:`, because the `botID`
already contains one.

Envelope:

```
Success:  { "ok": true,  "result": ... }
Error:    { "ok": false, "error_code": N, "description": "..." }
```

`error_code` mirrors the HTTP status. `description` is a stable human-readable
string meant for logs — it is **not** a flow-control mechanism.

Observed codes: `400` `BAD_REQUEST` / `TEXT_REQUIRED` / `ACTION_NOT_SUPPORTED` /
`REPLY_TO_MESSAGE_NOT_FOUND`, `401` `TOKEN_INVALID`, `403` `BOT_SUSPENDED` /
`CHAT_FORBIDDEN`, `404` `CHAT_NOT_FOUND`, `409` `CONFLICT_POLLING` (§3.1), `500`
`INTERNAL_ERROR`.

Message projection (the only one, deliberately thin — the domain `Message` has
~40 fields and none of the others leak):

```
BotMessage { message_id, from{id, name}, chat{id, type}, date, text }
```

`date` is in **seconds**, not milliseconds.

`getMe` returns `{ id, is_bot: true, username, first_name }`.

Server limits and defaults (configurable; these are the defaults):
`BOTAPI_UPDATES_MAX_LIMIT=100`, `BOTAPI_UPDATES_MAX_TIMEOUT=30` seconds,
`BOTAPI_STREAM_MAXLEN=10000`. Per request: `offset` absent or `0` acknowledges
nothing, `limit` defaults to `100`, `timeout` defaults to `0`. Negative values,
wrong types and an explicit `limit:0` are `400`; values above the maximum are
**clamped silently**.

### 2.2 Human-session surface

```
POST <base>/bot/register                  (X-Botapi-Platform-Key, server-to-server)
POST <base>/bots/{botID}/conversation     (human session — the "/start")
GET  <base>/bots/search/{query}           (human session)
```

### 2.3 BotSmith surface (management)

```
GET  <base>/bot-management/capability
GET  <base>/bot-management/bots
GET  <base>/bot-management/bots/{id}
GET  <base>/bot-management/dialogue
POST <base>/bot-management/commands
PUT  <base>/bot-management/administrators/{id}
```

Credentials: **human session (bearer or cookie) + `X-Secret`**. Nothing to do
with the bot token. Different envelope: `{ok, data}` on success and
`{ok:false, error:{code}}` on failure, served `no-store`.

Codes: `INVALID_INPUT` 400, `UNAUTHORIZED` 401, `FORBIDDEN` 403, `NOT_FOUND` 404,
`STALE_STATE` 409, `QUOTA_EXCEEDED` 422, `TOO_MANY_ATTEMPTS` 429,
`UNAVAILABLE`/`RECOVERY_REQUIRED` 503.

`POST /commands` is not CRUD: it is a **conversational state machine** with
optimistic concurrency control. Body:
`{operationID, expectedRevision, command, value?, botID?, expectedCredentialVersion?}`.
Command vocabulary: `/newbot`, `/mybots`, `/help`, `/cancel`, `value`, `select`,
`name`, `description`, `issue`, `rotate`, `revoke`, `archive`, `unarchive`,
`confirm`.

---

## 3. What pepibot discovered, and the SDK has to solve

Each of these six is a trap an author steps into once, in production, and spends
a while understanding. They are ordered by how much they hurt.

### 3.1 One consumer per bot — the server now evicts

**This changed on 2026-09-08** (commit `d4526381` in `backend-api-go`, spec
`docs/sdd/botapi/botsmith/14-poll-exclusion.md`). The previous text of this
section described the system's worst failure mode; today it describes a contract.

**Before**: two simultaneous `getUpdates` calls on the same bot **split** the
updates — each path received half, with no error and no log — because both polls
used the same consumer name and `XREADGROUP` distributes. From the outside it
looked like "a bot that sometimes doesn't answer," and nothing in the logs
explained it.

**Now**: there is a per-bot lock (`botapi:poll:<botID>`) and `getUpdates` returns
**`409 CONFLICT_POLLING`**. Chasky mirrors Telegram, which cuts off with
`409 Conflict: terminated by other getUpdates request`.

Three details of the mechanism the SDK needs, none of which follow from "there is
a 409":

1. **The arriving poll EVICTS the incumbent.** The lock is taken unconditionally
   (`SET` without `NX`), so **the `409` goes to the OLD poll**, not the new one.
   The server chose this because the common case is a bot restart, and making the
   process that just booted wait would be a daily tax to prevent a configuration
   accident that gets fixed once.

   A direct and non-obvious consequence: **`start()` is not an innocent
   operation.** Starting the SDK evicts whoever is polling that bot. In a
   deployment with two replicas, starting the second kills the first.

2. **Losing the poll does NOT lose messages.** The evicted poll returns **zero**
   entries — not the ones it had already read: delivering half would be the same
   silent split with fewer elements — and those entries stay **unacknowledged**,
   so the instance that evicted it picks them up. The SDK has to do nothing. The
   author will ask anyway, which is why it is written down here.

3. **The lock has a short TTL and is renewed per slice**; it does not span the
   whole poll. A process that dies frees the bot in seconds rather than waiting
   out the 30-second maximum. For the SDK that is good operational news:
   restarting a bot is fast.

**Verified live on 2026-09-09.** A smoke-test bot left polling was displaced by
a second one and received a real `409 CONFLICT_POLLING` from the server; the SDK
stopped, retried nothing, and reported which code it was. The whole of §3.1 is
now evidence rather than a reading of the server's spec.

**What the SDK must do with the `409`: stop, not retry.** It is terminal, like
`401`. A client's natural reflex is to retry anything that looks transient, and
here that reflex is catastrophic: two retrying instances enter an **eviction
war** — each displacing the other, neither processing anything — and the result
is worse than the silent split this change was meant to fix. Recorded as
guarantee **G7** (§8.1) and as a mandatory conformance case.

**And the message matters.** A `409` does **not** mean "misconfiguration": in a
rolling deployment it is the normal, correct flow, and the old instance should
die cleanly. The SDK says *"another instance took over polling for this bot; this
one is stopping"*, not *"configuration error"*. Telling a deploy apart from an
accident is impossible at the moment of the `409` — they are identical — and
pretending otherwise would be lying to the author.

### 3.2 The offset must ALWAYS advance

Even for an update already seen, one the handler could not process, or one that
blew the handler up. If the offset only advances on success, the bot gets stuck
retrying the same update forever and — worse — never sees the ones behind it.

This is the rule most easily broken when written by hand, because "I only
acknowledge what I processed correctly" sounds right. It is not: Chasky's
`offset` is **not** a business acknowledgement, it is a read cursor.

### 3.3 Delivery is at-least-once

The same `update_id` can come back: the client died between replying and
advancing the offset, or the entry stayed in the PEL. The `update_id` is **not**
reassigned on redelivery. Deduplication is the client's responsibility.

### 3.4 A fresh `Idempotency-Key` per logical message, the same one when retrying THAT message

It is a Chasky extension; Telegram does not know this header. It applies only to
`sendMessage`, and is scoped **per bot**, never per chat.

The trap: reusing a key across different messages makes the server return the
first result and **silently discard the second**. The call answers `200` with a
valid `BotMessage`. It looks like it worked. It did not.

Also, on a retry the **key wins over the body**: retrying the same K with
different text returns the original snapshot before the new content is even
validated.

### 3.5 The token leaks into logs through the transport

Because it travels in the path, the HTTP client embeds the full URL in its own
errors. A `connection refused` is enough to write the credential into a log.
Nobody has to log carelessly: logging the error is enough.

The server already redacts `/bot<token>/` in its own logs. **The client has to do
the same on the outside**, and that is the SDK's job, not the author's: the
author does not know the error carries a URL inside.

### 3.6 Identifiers are strings, and fields are named differently

`chat.id`, `from.id` and `message_id` are **strings** in Chasky and **numbers** in
Telegram. The sender is `from.name` in Chasky and `from.first_name` in Telegram.

The hard consequence: **a Telegram SDK does not work against Chasky without
modification.** Changing the base URL is not enough. This is the evidence behind
the foundational decision in §4.

pepibot solved it with a `flexID` type that remembers the shape an identifier
arrived in and re-emits it the same way. **That type is an artifact of running
both platforms in one binary, and must NOT be ported to the SDK** (§9).

---

## 4. The foundational decision — Chasky-native, not Telegram-compatible

**CLOSED (D2): native.** With a distinction that matters: native in the **types**,
familiar in the **mental model**.

### Why not compatible

Mimicking a Telegram SDK's API promises something the contract cannot deliver —
"port your bot almost untouched." The identifiers have a different type. A
numeric `chat_id` finds nothing in Chasky; a quoted one is rejected by Telegram.
Keeping up the façade forces coercion everywhere, and every identifier coercion
is a **silent error**: it throws nothing, it points at the wrong chat or at none.

And the list of differences does not stop at the types:

| | Telegram | Chasky |
|---|---|---|
| `chat.id`, `from.id`, `message_id` | number | **string** |
| sender name | `first_name` | **`name`** |
| concurrent poll | explicit `409` | **explicit `409`** — now matches |
| `Idempotency-Key` | does not exist | required by discipline |
| `sendChatAction` | broad vocabulary | **`typing` only** |
| attachments, media, buttons | yes | **not in v1** |
| `setWebhook` on the token surface | yes | **no, deliberately** (§11) |

An author who brings a Telegram bot and finds an API that looks similar but fails
differently is worse off than one who finds an honest, different API. False
familiarity costs more than a declared difference.

**Note (2026-09-08):** the concurrent-poll `409` went from difference to match
(§3.1). That **does not reopen this decision**. The row that makes a Telegram SDK
fail against Chasky is the first one — `string` versus number — not this one: one
more match in a table of seven does not change that identifiers have a different
type, and identifier coercion is still a silent error. What the `409` does buy is
that **error classification** (§10.2) moves closer to Telegram's, which makes
porting error handling cheaper. That is a real saving, and it is not the
foundational decision.

### What is borrowed

The **mental model**, which is what actually ports: updates with a monotonic
`update_id`, `offset` as a cursor, `chat_id` as a destination, and handler
composition (`bot.on(...)`, middleware). A telegraf author recognises the shape
in five minutes even though not one line is reused.

That is 80% of the porting benefit with none of the type fiction.

---

## 5. Decision — the three SDKs and their order

**CLOSED (D1): three of them — TypeScript, Go and Python — in one monorepo,
delivered in the order TypeScript → Go → Python.**

### 5.1 Why TypeScript first

1. **The SDK's audience is not the backend team.** They are third parties writing
   bots. The reference points in this space — `telegraf`, `python-telegram-bot` —
   are JS and Python.
2. **The marginal value is higher in JS, and pepibot proves it.** Today a Go
   author talks to Chasky in 554 lines of standard library with no dependencies,
   and the file that demonstrates it already exists. A JS author faces those same
   554 lines **plus** discovering the six traps in §3 alone.
3. **The rest of the product is already JS.** Next.js frontend, enterprise
   portal. The same toolchain the team already operates.
4. **The future webhook is Node.** When outbound webhooks exist (§11), the bot's
   HTTP handler will mostly live in a serverless runtime.

And a distinction that is not cosmetic: it is written **in TypeScript**, and the
published `.d.ts` files are **part of the public contract**, not documentation.
Having `sendChatAction({ action: "upload_photo" })` fail in the editor rather
than as a `400 ACTION_NOT_SUPPORTED` in production is half the SDK's value,
because half the traps in §3 are shape traps.

### 5.2 Why Go second

The adoption argument favoured Python — it has nothing today, and LLM-backed bots
are mostly Python. A more urgent argument wins: **the conformance suite (§6 of
`01-organization.md`) proves nothing with a single consumer.**

A suite run by one implementation does not validate the contract; it validates
that implementation against itself. Only the **second** port surfaces the cases
where the suite was ambiguous, where the "contract" was really a detail of how
the first one did it, and where a guarantee was written in prose that admitted
two readings.

Go comes before Python because **half the work is already written** in pepibot
and because the same team that maintains the server maintains it, without a
context switch. It is the cheapest second port, and the second port is what turns
conformance into something real.

### 5.3 Why Python third

It brings the most adoption and carries the least contract risk, because it
arrives with the contract already shaken out by two implementations. Arriving
third does not diminish it: it makes it the cheapest of the three.

### 5.4 pepibot's role

**It is neither promoted to `go/` nor demoted to an example.** Its function
differs from an SDK's: it is the only client that runs against **Chasky and
Telegram at once**, and that comparison is what makes the differences in §4
visible. A Chasky-native SDK loses exactly that capability.

It lives in `reference/pepibot/` as the **conformance client**: the minimal
stdlib implementation that exercises the server contract end to end. The Go SDK
is written looking at it, not derived from it (D5, §12).

---

## 6. Decision — minimal surface and packaging

**CLOSED (D13): one publishable artifact per language, with two separate
entrypoints.** The artifact is named after the product — BotSmith (D9) — and the
two surfaces are subpaths.

| | Runtime | Management |
|---|---|---|
| npm | `@chasky/botsmith` | `@chasky/botsmith/management` |
| Go | `.../botsmith-sdk/go` | `.../botsmith-sdk/go/management` |
| PyPI | `chasky_botsmith` | `chasky_botsmith.management` |

**Root entrypoint — the bot runtime (first delivery).** Credential: the token, in
the path. Surface: `getMe`, `getUpdates`, `sendMessage`, `sendChatAction`, plus
all the scaffolding in §7.

**`/management` subpath — management (later, and only on demand).** Credential:
**human session + `X-Secret`**. Surface: the six `/bot-management` endpoints.

Two advantages over publishing separate packages: the product's name **is** the
package's name, and the three ecosystems come out symmetric. In Go, a module with
a subpackage was already the natural shape; now npm and PyPI mirror it instead of
each inventing its own.

### Why the two surfaces stay separate on the inside

Sharing an artifact does **not** make them one thing. They remain two distinct
systems that happen to talk about the same object, and the contrast is verified
against the server:

| | Runtime | Management |
|---|---|---|
| Credential | token in the **path** | human session **+** `X-Secret` |
| Route | `/bot<TOKEN>/sendMessage` | `/bot-management/commands` |
| Server auth | `IsPublic: true, NoRequiresAuthentication: true` | session middleware + API secret |
| Success envelope | `{ok, result}` | `{ok, data}` |
| Error envelope | `{ok:false, error_code, description}` | `{ok:false, error:{code}}` |
| Error code type | **number** (`409`) | **string** (`"STALE_STATE"`) |
| Shape | REST with methods | state machine with CAS |
| Who runs it | the bot process, 24/7 | a human, once |

From that come **four implementation requirements**, not suggestions. They are
what keeps a shared artifact from reintroducing the problems separation avoided:

**R-A. Separate constructors — never one that accepts both credentials.**
`createBot({ token })` and `createManagementClient({ session, apiSecret })`.
Never a single constructor taking token *or* session+secret: that was the real
risk, and it survives intact inside one package if allowed. With two
constructors, sending the `X-Secret` from the bot process is something you have
to write on purpose again.

It matters because the damage is asymmetric: a leaked **token** lets an attacker
send messages as that bot — bad, bounded, closed by rotating; the **`X-Secret`**
is a *platform* secret, and that is not the same incident.

**R-B. Distinct error types per surface.** `ChaskyApiError` (runtime, numeric
`code`) and `ManagementError` (management, string `code`). They share no base
class carrying a common `code` field.

This is the requirement that neutralises the worst risk of sharing a package:

| `409` on… | Code | Means | The client must |
|---|---|---|---|
| Runtime | `CONFLICT_POLLING` | another instance evicted you | **stop**, never retry |
| Management | `STALE_STATE` | your `expectedRevision` is stale | **re-read and retry** |

**Same number, opposite instruction.** With a shared error type, an
`if (err.code === 409) retry()` written for management and reused in the runtime
puts two instances into the eviction war of §3.1. With distinct types, that `if`
does not compile against the wrong surface. The envelopes already differ, so
separate types fall out of the contract rather than out of discipline.

**R-C. The runtime imports nothing from the management subpath.** Verifiable with
a test, not a convention. That keeps management code out of the bundle for anyone
who only runs a bot, and writes the dependency direction down.

**R-D. What little they share lives in the internal module** (`core/`,
`internal/`, `_core/`): token redaction, backoff, HTTP client. Never envelopes,
never error types, never credentials. **If that module starts growing, it is a
sign that something meant to stay separate is leaking.**

### Delivery order

The runtime ships first and management later, even though they travel in the same
artifact: the subpath can appear in a later version without breaking anyone.

**Why BotSmith is not urgent:** almost every author creates the bot **once**, by
hand, in the portal. Automating it serves one concrete case — CI provisioning
bots per environment — and until that case exists it is surface being maintained
unused.

### Naming standard

For any future subpath the standard is **the role in one word, in the contract's
own vocabulary**: `management` because it mirrors `/bot-management`, the route it
consumes. No new vocabulary is invented when the server already named the
surface.

---

## 7. The SDK's API surface

A contract sketch, not an implementation: signatures and types, no bodies.

It is written in TypeScript because that is the first delivery (§5). **Go and
Python do NOT transliterate it**: they port the invariants and adopt their own
ecosystem's shape. What is invariant and what is idiomatic lives in
`01-organization.md` §3, and it is the rule that keeps the Python SDK from
reading like badly translated TypeScript.

### 7.1 Domain types

```ts
type ChatID    = string;  // "bot:{botID}:{userID}"  — ALWAYS a string
type UserID    = string;  // "bot:{uuid}" or the human's id
type MessageID = string;
type UpdateID  = number;  // the ONLY numeric one. See §9.

interface BotUser    { id: UserID; name: string }
interface Chat       { id: ChatID; type: string }
interface BotMessage { messageId: MessageID; from: BotUser; chat: Chat; date: Date; text: string }
interface Update     { updateId: UpdateID; message?: BotMessage }
interface BotIdentity { id: UserID; isBot: true; username: string; displayName: string }
```

`date` arrives in seconds and is exposed as a `Date`. `displayName` is mapped from
the server's `first_name`: that asymmetry — Telegram-style `first_name` in
`getMe`, Chasky-style `name` in `from` — is a server inconsistency, and the SDK
absorbs it instead of propagating it (request S2 in §13).

### 7.2 Raw client

A 1:1 wrapper over the four methods, with no loop. It is what the runtime uses
underneath, and what anyone wanting full control needs.

```ts
class ChaskyBotClient {
  constructor(options: { token: string; baseUrl?: string; fetch?: typeof fetch });

  getMe(signal?: AbortSignal): Promise<BotIdentity>;
  getUpdates(params: { offset?: number; limit?: number; timeoutSeconds?: number },
             signal?: AbortSignal): Promise<Update[]>;
  sendMessage(params: { chatId: ChatID; text: string; replyToMessageId?: MessageID },
              signal?: AbortSignal): Promise<BotMessage>;
  sendChatAction(params: { chatId: ChatID; action: "typing" },
                 signal?: AbortSignal): Promise<true>;
}
```

`action` is the literal `"typing"` and not a string: Telegram's vocabulary is
valid in Telegram and `400 ACTION_NOT_SUPPORTED` here. Having the compiler say so
before the server does is free.

### 7.3 Runtime — what most people will use

```ts
const bot = createBot({
  token: process.env.CHASKY_BOT_TOKEN!,
  baseUrl: process.env.CHASKY_API,          // default: production
  transport: polling({ limit: 50, timeoutSeconds: 25 }),  // the only one today (§11)
});

bot.command("start", ctx => ctx.reply("Hi, I'm pepi."));
bot.on("text",       ctx => ctx.reply(`You said: ${ctx.message.text}`));

bot.onError(err => logger.error(err));       // already redacted (§10.3)
bot.onFatal(err => process.exit(1));         // 401/403/409: the bot does not continue

await bot.start();
await bot.stop();                            // cuts the in-flight long poll
```

`ctx` carries the update, the message, the `chatId`, the raw client, and the
shortcuts `reply` (a `sendMessage` to the update's chat, with a managed
`Idempotency-Key`) and `typing`.

**The runtime never sends `sendChatAction` on its own.** Typing is a product
decision — whether it helps depends on how long the bot takes to answer — so the
author calls `ctx.typing()` when they want it. Sending it automatically would
double every bot's request count, including bots that answer in five milliseconds
where the indicator is just flicker. pepibot sends it before every reply; that is
a choice its author made, not a behaviour to inherit.

**A domain detail the SDK must reflect:** a bot **cannot start** a conversation.
It can only reply in a chat it already knows, because the conversation is created
by the human opener (`POST /bots/{botID}/conversation`). The `chatId` is learned
from updates. A method suggesting "send this user a message" would be an API lie;
if the SDK exposes sending outside a handler, it must ask for a `chatId` the
author stored themselves.

---

## 8. Semantics: what the SDK guarantees and what it delegates

This is the section that makes the SDK more than a `fetch` wrapper, and the one
to read in full before writing a bot.

### 8.1 Guarantees

- **G1 — One in-flight poll per instance.** Calling `start()` on an
  already-started instance is an immediate local error, not a bot receiving half
  its messages.
- **G2 — The offset always advances.** It is computed as `max(update_id) + 1`
  over the **received** batch and sent on the next poll regardless of what
  happened to the handlers: exception, timeout, rejection, already-seen update.
  Advancing belongs to the transport, not to the business logic.
- **G3 — Deduplication by `update_id`, using a threshold.** Everything with
  `update_id <= lastSeen` is discarded, and `lastSeen` is **a single integer**:
  no data structure is needed. The server delivers in strictly ascending order
  and never emits regressive identifiers, so an `update_id` below the threshold
  is **always** a duplicate (D6, §12 — verified against the code). pepibot uses a
  `map` that grows forever; in a process that lives for months that is a leak,
  and the threshold removes it at the root.

  That integer is **the same one** that feeds the offset: `offset == lastSeen + 1`
  at all times (D7, §12). The SDK stores one number, not two.
- **G4 — Managed `Idempotency-Key`.** A fresh key per logical message, the
  **same** one on every internal retry of that send. The author never writes it
  or sees it. If the randomness source fails, **nothing is sent**: sending
  without a key is worse than not sending, because a retry would create a
  duplicate.
- **G5 — Token redaction on every error leaving the SDK.** Including transport
  errors, and recursively through `cause`, `stack` and any field carrying a URL.
- **G6 — Clamping `limit` and `timeout`.** A reasonable `timeout: 60` must not
  turn into a `400`; it is clamped to the server's maximum and a warning is
  emitted. Values the server rejects outright — negatives, `limit: 0` — are
  rejected in the SDK, with the reason, before spending a request.
- **G7 — Backoff retry on the transient, a hard stop on the terminal.** `401`,
  `403 BOT_SUSPENDED` and **`409 CONFLICT_POLLING`** stop the bot and fire
  `onFatal`: retrying a revoked token is infinite noise, and retrying a `409` is
  an **eviction war** where two instances displace each other and neither
  processes anything (§3.1). Network errors, `5xx` and timeouts retry with
  exponential backoff and jitter.
- **G8 — Clean cancellation.** `stop()` aborts the in-flight long poll; it does
  not wait up to 30 seconds for the server's deadline to expire.
- **G9 — Identifiers are re-emitted exactly as received.** The SDK never converts
  an id (§9).

### 8.2 Delegated — explicitly, and worth reading

- **L1 — Exactly-once does not exist.** The server does not promise it and the
  SDK cannot invent it. If a handler has outward effects — charging, sending
  mail, opening a ticket — the idempotency of **that** effect is the author's.
  G3 reduces duplicates; it does not eliminate them.
- **L2 — Offset persistence across restarts.** By default the offset lives in
  memory: on restart the server redelivers the PEL and the bot sees already
  processed updates again. An optional `OffsetStore` hook is exposed — `load()` /
  `save(n)`, invoked once per batch — and **the default's reprocessing is
  documented** (D7, §12).
- **L3 — One process per bot.** G1 holds **per instance**: the SDK cannot see
  another replica. **Since 2026-09-08 the server does reject it** with a `409`
  (§3.1), so this stopped being the system's worst failure mode — it was silent,
  now it is loud — and became a normal operational condition.

  What stays delegated is **deciding how many processes run**. The server leaves
  the most recently started one polling; if the deployment brings up two
  replicas, one will die with a `409` every time. The SDK reports the fact;
  keeping it to one is the deployment's job.
- **L4 — Stream retention.** `BOTAPI_STREAM_MAXLEN=10000` per bot, and `XTRIM`
  can take unacknowledged updates with it. A bot down for longer than that window
  loses updates. That is operations, not SDK.
- **L5 — Meaning.** What to reply, when, and with what text.

---

## 9. Identifiers

**One rule: in Chasky every identifier is a `string`, and the SDK never converts
them.** It receives strings, stores strings, re-emits strings.

Observed against a live server on 2026-09-09, and worth reproducing exactly
because the shape is not what a careful reading of the server spec suggests:

```
chat.id     bot:bot:1a140818-…-5a3e27885501:3a532be3-…-9fd9424fd5bc
from.id     3a532be3-…-9fd9424fd5bc          (the human: a bare uuid)
message_id  botmsg:0a621ee28afcb8f6…
```

**`chat.id` carries `bot:` twice.** The server spec says the conversation id is
`bot:{botID}:{userID}` and, separately, that `Bot.ID` is `bot:{uuid}` — so the
prefix appears once from the conversation and once from inside the botID. Both
statements are correct; substituting them is what surprises.

All three SDKs were run against a live server on 2026-09-09 and printed the same
shape, so the mapping is verified three times over rather than assumed once.

**That is observable structure, not contract**, and this is the case that proves
why the distinction matters. The SDK never parsed these ids, so the double prefix
cost it nothing — it round-tripped the string and the bot worked on the first
try. An SDK that had "understood" the format well enough to split out the botID
would have broken here, silently, on a real server. The server holds the same
rule for itself: it does not parse ids to authorise. **An id is an opaque
label.**

**`flexID` is not ported.** pepibot's type, which remembers whether an id arrived
as a string or a number, solves a problem that only exists when one binary talks
to both Chasky and Telegram. In a Chasky-native SDK that problem does not exist,
and copying it would drag a solution in without its problem: it adds a custom
type where `string` suffices, and asks the author to think about an ambiguity
their platform does not have.

**`update_id` is the one numeric exception**, and it deserves its paragraph. It
is an `int64` server-side (`INCR botapi:seq:{botID}`, one per bot, starting at
zero). In JS integers are exact up to 2^53; a real `int64` does not fit. In
practice a per-bot counter comes nowhere near that ceiling, so it is represented
as a `number`. **This is written down so nobody "fixes" it to `BigInt` without
knowing why, and so that if the server ever changes the sequence generator — to a
snowflake, to a timestamp — this decision is reopened.** Gaps in the sequence are
valid and expected; the SDK must not treat them as loss.

---

## 10. Errors and redaction

### 10.1 Types

```ts
class ChaskyApiError extends Error {
  readonly code: number;         // 400, 401, 403, 404, 409, 500 — flow control
  readonly description: string;  // server string — logs ONLY
  readonly method: string;       // "sendMessage", ...
}
class ChaskyTransportError extends Error { readonly cause: unknown }
```

Flow control goes **through `code`**, never through `description`: the server
declares the description readable and stable, but not enumerated.

### 10.2 Classification

**Classification is by code *and by which call produced it*, never by
`description`.** An earlier draft of this table split `403` into
`BOT_SUSPENDED` (terminal) and `CHAT_FORBIDDEN` (business), which contradicted
§10.1: the server does not declare `description` enumerated, so flow control
must not read it. The **method** resolves it without touching the string, and
more robustly.

| Class | Codes | What the SDK does |
|---|---|---|
| Terminal | `401`, `403`, `409` — **from the poll** | Stops the bot, fires `onFatal`. No retry. A `409 CONFLICT_POLLING` retried is an eviction war (§3.1), and the message says "another instance took over polling", not "configuration error". |
| Business | `400`, `403`, `404` — **from a single call** | Returns the error to the caller. No retry: retrying an empty `text` yields an empty `text`. |
| Transient | `500`, `5xx`, network, timeout | Exponential backoff with jitter, **reusing the same `Idempotency-Key`**. |

The reasoning: a `403` while **polling** means this bot is barred from polling at
all — terminal. A `403` from a **send** means that one chat is not ours — the bot
lives on. Same shape for `401`. Reading the method is both correct and immune to
a description the server never promised to keep enumerated.

### 10.3 Redaction — mandatory, not optional

**No object the SDK exposes may contain the token.** The rule is not "be careful
when logging": the token travels in the path and the transport embeds the URL in
its own errors, so the `Error` is born contaminated before anyone touches it.

Implementing the rule:

1. Every error crossing the SDK boundary passes through a redactor that replaces
   the token with `<REDACTED>` in `message`, `stack`, and recursively in `cause`.
2. Both the **token** and the path pattern `/bot<anything>/` are redacted, to
   cover a token other than the configured one.
3. The SDK **does not log on its own**. It emits events; logging is the author's
   call. But everything it emits is already redacted, so the author's decision
   cannot leak the credential.
4. The token never appears in the client's representation: `toString`, `inspect`,
   serialisation.

**And one more rule pepibot does not cover:** if `baseUrl` is `http://` and the
host is not loopback, the SDK **warns once at construction** (D8) — a token in
the path over plaintext is written into every proxy along the way. Over HTTPS the
path is encrypted; over HTTP it is not. "Loopback" means `localhost`,
`127.0.0.0/8`, `::1` and `*.localhost`, and deliberately not `*.local`. Silence
it explicitly with `allowInsecureTransport: true`.

---

## 11. Webhook: the reserved seam, with no commitment to shape

Chasky has **no** outbound webhook delivery today. It is specified and unbuilt in
the server's `docs/sdd/botapi/botsmith/12-webhook-delivery.md`. The SDK leaves the
seam and promises nothing more.

**What is committed:** the transport is a parameter, and the author's handlers do
not change when it changes.

```ts
createBot({ token, transport: polling({ ... }) })    // today
createBot({ token, transport: webhook({ ... }) })    // once it exists
```

That is the whole promise: `bot.on("text", ...)` survives the switch.

**What is NOT committed:** the shape of the HTTP handler, the name of the secret
header, the server's retry model, the body format. All of it is unbuilt, and
committing to it today would be inventing the server's contract from the client.

**Three things the SDK does know already**, because they are decided server-side:

- **Polling and webhook are mutually exclusive.** This is not copied Telegram
  style: both would consume from the same consumer group and compete, with the
  same invisible symptom as §3.1. Configuring both transports must be an SDK
  construction error, not something discovered in production.
- **The URL is registered through BotSmith, not through the token.** There will
  be no `setWebhook` on the token surface, deliberately: a leaked token today
  lets someone send messages as the bot — bad, bounded, closed by rotating; if it
  also allowed registering a webhook, the attacker would redirect **all inbound
  traffic** to their own server and read conversations without the owner
  noticing. When it exists, webhook configuration lives in the **management**
  subpath, not in the runtime entrypoint.
- When a bot is in webhook mode, `getUpdates` answers with an **explicit error**,
  not an empty list. The SDK must translate that error into a message saying "you
  are asking on the wrong channel", because an empty list reads as "no messages"
  and is the worst possible confusion.

---

## 12. Decisions

All thirteen are closed. They are applied, not re-litigated, unless new evidence
shows up — and when it does, the record says what the old reasoning was so the
change is deliberate.

| # | Decision | Resolution | Rationale |
|---|---|---|---|
| **D1** | Languages and order | **TS → Go → Python**, all three | The second port is what validates conformance; Go is the cheapest second. §5 |
| **D2** | Telegram-compatible or native? | **Native**, with Telegram's mental model | Ids are string vs number; every coercion is a silent error. §4 |
| **D3** | Surface | **Two separate surfaces**; runtime first, management later | Incompatible envelopes and a `409` that means the opposite on each. *How* they are packaged is fixed by **D13**; separation is held by requirements R-A to R-D in §6 |
| **D4** | Webhook | **Transport seam, no commitment to shape** | The server has not built it yet. §11 |
| **D5** | pepibot's fate | **Conformance client** in `reference/pepibot/`, not the seed of `go/` | It is the only client running against both platforms, and a native SDK loses that. The actual move is a delivery-2 task |
| **D6** | Deduplication by `update_id` | **Threshold `> lastSeen`**: one integer, no data structure | Verified against the code (below). Cheaper **and** more correct than a finite window |
| **D7** | Offset persistence | **Optional** `OffsetStore` hook, in-memory default | A disk default surprises; an in-memory one reprocesses **visibly**. And the state is **a single integer** (below) |
| **D8** | Non-loopback `http://` | **Warn once**, do not refuse; explicit opt-out | Refusing breaks legitimate internal staging — TLS terminated at the ingress, tunnels, compose |
| **D9** | Layout and names | **Monorepo `botsmith-sdk`** —BotSmith names the **whole bot product**, not just the manager— one directory per language at the root; npm scope **`@chasky/`** confirmed available | Three ports of one contract, same team, same time. Detail in `01-organization.md` |
| **D10** | Conformance format | **JSON cases** + one HTTP fake per language | Idiomatic and process-free. **Reversible** (below) |
| **D11** | Versioning | **Independent per language** + contract version declared separately | One artifact per language (D13), so semver is per language: a packaging fix in Python does not force empty releases in TS and Go. The question that matters —do they guarantee the same?— is answered by the contract version |
| **D12** | Translate `docs/` to English | **Done on 2026-09-09.** Included renaming `01-organizacion.md` → `01-organization.md`, updating links, and dropping the *"(in Spanish for now)"* notices | It was tracked as a numbered decision rather than a loose TODO precisely so it would be counted among what was pending instead of evaporating |
| **D13** | Packaging of the two surfaces | **One artifact per language, two entrypoints**: `@chasky/botsmith` and `@chasky/botsmith/management` | The artifact is named after the product (D9) and the three ecosystems come out symmetric. Supersedes D3 on the *how*; requirements R-A to R-D in §6 keep the real separation inside |

### D6 verification (2026-09-08)

Read in `internal/core/botapi/infrastructure/redis/`, branch
`cc-jose-nieto/botapi`:

1. **`producer.go`** — the Lua script's `XADD` uses an **explicit stream ID**
   equal to `<update_id>-0`, so **stream order is `update_id` order**. The script
   also compares against the stream's last ID and aborts rather than emit a
   regressive one: there are **valid gaps, never backwards ids**.
2. **`updates.go`** — the reader walks the **PEL** first (`XREADGROUP` from
   `"0"`, cursor advancing by `entry.ID`) and only then the **new** entries
   (`">"`), which by construction have ids greater than any pending one.

From that: **every response arrives in strictly ascending order**, and so does
the sequence across responses as long as the offset advances (G2). The only
source of repetition is a PEL redelivery, and it always carries
`update_id <= lastSeen`.

**The threshold does not over-filter**: with no regressive identifiers, an
`update_id` below the threshold is always a duplicate.

**And it is more correct than a finite window.** If the consumer group is
recreated — the reader's own `NOGROUP` path — the last-delivered-id resets to
zero and **the entire stream** is redelivered. A window of N=1000 reprocesses
everything older than those thousand entries; the threshold does not flinch. It
is chosen for correctness; being one integer instead of a structure is the bonus.

*Scope*: the threshold holds **within the process's lifetime**. On restart
`lastSeen` starts at zero and the PEL is reprocessed — that is **D7**, not D6,
and it is the default documented in L2.

### D7 — and the finding that the state is a single integer

`OffsetStore` is a two-method interface, `load()` and `save(n)`, invoked **once
per batch** and not per update: saving per update would be correct and slow.

And there is a simplification falling out of D6 that is worth writing down before
implementing it three times: **the offset and the dedup threshold are the same
number.**

Under G2 the offset is `max(update_id in batch) + 1`, and under G3 the threshold
is `max(update_id processed)`. Since the offset advances regardless of what
happens to the handlers, `offset == lastSeen + 1` holds at the close of every
batch. **They are not two pieces of state: they are one.** The `OffsetStore`
persists one integer, and both fall out of it.

The default is in-memory because a disk default surprises — where does it write,
with what permissions, what happens in an ephemeral container? — and because
reprocessing on restart violates nothing: at-least-once is already delegated in
L1. It is visible, it is documented, and whoever does not want it implements the
interface.

### D10 — JSON cases, and why not the single binary

The alternative was a conformance binary hosting the fake, with all three SDKs
hitting it over real HTTP. It is **more faithful** — real HTTP, not a mock — and
it is paid for dearly: it has to be built and maintained, every CI has to start
it, wait for the port and kill it, and a whole family of new failures appears
that are not the SDK's (occupied ports, startup races).

JSON cases with a per-language fake use the HTTP mock each ecosystem already has,
with no external process. **JSON and not YAML** because all three languages parse
it without adding a dependency.

The real risk is three fakes interpreting a case differently. It is bounded by
having the case declare **the expected requests exactly** — method, path,
headers, body — and having the fake merely replay them: what is verified is the
observed against the declared, never logic living inside the fake.

It is a **reversible** decision, and that is half the argument: if the three
fakes start diverging, migrate to the single binary with the same cases.

### D11 — package version and contract version

Each language publishes one artifact (D13) with its own semver: a packaging fix
in Python does not force empty releases in TypeScript and Go.

Separately, each artifact declares **which contract version** it satisfies, and
conformance cases declare which version they belong to. That answers the one
question that actually matters across three implementations: *do these two SDKs
guarantee the same thing?* — which the package version does not.

The contract version is `MAJOR.MINOR`: **MINOR** when a guarantee is added,
**MAJOR** when an existing one changes.

---

## 13. What we ask of the server

These come out of this analysis and are `backend-api-go` tickets, not SDK work.

- **S1 — `409` on concurrent `getUpdates`, like Telegram. ✅ RESOLVED
  (2026-09-08, commit `d4526381`).** This was finding #1: two consumers split the
  updates with no visible error, and no amount of client discipline could detect
  it from outside. Today there is a per-bot lock and a `409 CONFLICT_POLLING`
  (§3.1). The system's worst failure mode — silent, intermittent, impossible to
  diagnose — became an error message.

  **A caveat for the server repo, not for the SDK:** `Req.X1` in
  `14-poll-exclusion.md` says the *arriving* poll fails; the implementation does
  the opposite and **evicts the incumbent**, for the reason given in the commit.
  The code wins and the SDK is written against the code; that spec is stale.
- **S2 — Normalise `getMe`.** It returns `first_name` (a Telegram name) where the
  rest of the contract uses `name` (a Chasky name). Having chosen not to be
  Telegram-compatible, that asymmetry buys nothing and confuses. Adding
  `display_name` while keeping `first_name` for compatibility would be enough.
- **S3 — Publish the effective limits.** `BOTAPI_UPDATES_MAX_LIMIT` and
  `BOTAPI_UPDATES_MAX_TIMEOUT` are configurable, and today the client has to
  hardcode them in order to clamp (G6). Exposing them in `getMe` — or in a
  `getLimits` — lets the SDK adapt to the instance instead of guessing it.
- **S4 — Document per-bot retention.** Approximate `XTRIM` can take
  unacknowledged updates. An author needs to know how long their bot can be down
  before losing messages; that number is not published today.
- **S5 — `Retry-After` on BotSmith's `429`.** Minor. Without the header, a
  `TOO_MANY_ATTEMPTS` client can only guess the backoff.
- **S6 — A developer key for `/bot-management`.** *Not a papercut like S2–S5: it
  decides whether third parties can manage their own bots at all.*

  Mark the `/bot-management` group `IsPublic` so it skips the global `X-Secret`
  gate, and give the group its own middleware validating
  `x-chasky-dev-secret: sk_…`, scoped to the bots its owner owns. **The bot
  runtime already works exactly this way** — `IsPublic` plus
  `ResolveBotToken` — so this is a pattern in production, not a new design.

  The risk is the same one this repo already survived once: `IsPublic` removes a
  guard, and a replacement that fails open serves bot administration to anyone.
  The middleware must be fail-closed by construction, and tested against an
  **absent** header, not only a wrong one. Full proposal, including what the SDK
  should absorb, in [`02-developer-api.md`](02-developer-api.md).

---

## 14. Out of scope for the first delivery

Attachments and media (the server only does text in v1). Buttons and callbacks.
Inline keyboards. Presence. Message editing and deletion. Groups (the model is one
bot serving many users, each in their own private chat). Bot registration from the
SDK (`POST /bot/register` uses a server-to-server platform key and must not leave
the platform). Webhook. Automatic retry at the handler level.

None of it is ruled out; it is **out of scope for the first delivery**, and in
almost every case for the same reason: the server does not offer it yet.

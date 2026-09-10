# Proposal — a developer API for the SDK, with its own key

Status: **proposal. Nothing is built, on either side.**

Raised 2026-09-09 and reshaped three times before landing here. The earlier
drafts are recorded in the section at the end, because the differences between
them are the argument.

---

## The proposal

A **new** surface, for programmatic callers, authenticated by a key the
developer generates from a panel:

```
x-chasky-dev-secret: sk_…
```

`/bot-management` is not touched. The portal keeps its dialogue, its session and
its `X-Secret`, and nothing about BotSmith has to move for this to ship.

## Two reasons, and the second is the one that convinced me

**1. It separates the credential without dragging the portal along.** Moving
`/bot-management` onto a developer key would have forced the portal's BFF to
migrate at the same time. A new surface has no incumbent to break.

**2. The dialogue is a bad API for code, and that is not a flaw in it.**
`/bot-management/commands` is a conversational state machine. Creating a bot is
four chained POSTs:

```
{command: "/newbot",  expectedRevision: 0}
{command: "value", value: "MyBot",   expectedRevision: 1}
{command: "value", value: "mybot",   expectedRevision: 2}
{command: "confirm",  expectedRevision: 3}
```

That is right for a person typing in a portal. For a CI job provisioning one bot
per environment it is hostile: four round trips, conversational state to carry,
and a `messageCode` to translate. The same intent as one call:

```
POST /developer/bots  {"name": "MyBot", "username": "mybot"}  ->  the bot
```

A surface built for the SDK can be shaped like an SDK. Reusing the dialogue
would have made every client re-implement a conversation it has no reason to
have.

## Why two surfaces will not drift

The obvious objection to a second surface is divergence: two ways to create a
bot, two sets of rules, two places to fix a bug.

That does not apply here, because the server is already hexagonal. The rules
live in `internal/core/botsmith/domain` — `botsmith.transition.go`, the name
validation, the quota, the CAS — and the HTTP handlers are input adapters over
it. The dialogue and the developer API would be **two adapters on one domain**.

A new rule about bot names, or a change to the quota, applies to both by
construction. The thing that would drift is business logic duplicated into a
handler, and that is a mistake this repo's architecture already prevents.

## Shape

REST, scoped implicitly to whoever owns the key.

| | |
|---|---|
| `POST /developer/bots` | create · `{name, username, description?}` |
| `GET /developer/bots` | list, `cursor`/`limit` |
| `GET /developer/bots/{id}` | detail |
| `PATCH /developer/bots/{id}` | name and description, with `expectedMetadataVersion` |
| `POST /developer/bots/{id}/credential` | issue or rotate — **reveals the token once** |
| `DELETE /developer/bots/{id}/credential` | revoke |
| `POST /developer/bots/{id}/archive` · `/unarchive` | lifecycle |

Optimistic concurrency stays where it earns its keep — `expectedMetadataVersion`
and `expectedCredentialVersion` guard the fields that matter — but the
conversational `expectedRevision`, which exists to order a dialogue, does not
come along.

## What it needs from the server

- **A developer panel** to issue, list and revoke keys.
- **Hash at rest, reveal once**, the discipline `SecretReveal` already follows.
- **Its own middleware**, checked *instead of* `ValidateApiSecret` on these
  routes. If the global gate still applies, a developer needs both credentials
  and nothing was gained.
- **Scope every route to the key's owner.** This is the load-bearing
  requirement: without it an `sk_` is the platform secret with extra steps.
- **The `sk_` prefix**, so a key pasted into a browser bundle is visible in
  review — the property Stripe gets from `sk_`/`pk_`.
- Optionally: expiry, last-used timestamps, per-key audit. These make an
  incident diagnosable instead of total.

## What it does to the SDK

A **new public package** for third parties, over these endpoints. Ordinary
shape, ordinary credential, no server-only guards beyond keeping an `sk_` out of
a browser — the same rule Stripe's `sk_` lives under.

And it raises a question worth asking out loud: **does `@chasky/botsmith-admin`
still have a reason to exist?** It wraps the dialogue, whose only caller is the
portal's BFF, which lives in another repo and may well prefer to call its own
backend directly. If it does, the admin package is code kept alive for nobody.
Worth deciding rather than inheriting.

## Recorded as S6

In §13 of the contract, deliberately apart from S2–S5: those are papercuts, and
this decides whether third parties can manage their own bots at all.

## How this proposal changed

Kept because the distinctions are the substance, and someone reading later
deserves to see they were argued rather than assumed.

1. **`sk_` replaces `X-Secret` everywhere.** Wrong: `X-Secret` guards the whole
   API, not just this.
2. **A separate surface, `/bot-management` untouched, BotSmith unchanged.**
   Wrong in the other direction — it read "BotSmith stays" as "the credential
   stays", and left the actual problem unsolved.
3. **`/bot-management` moves onto `x-chasky-dev-secret`.** Right about the
   credential, but it forced the portal to migrate in lockstep and left the SDK
   speaking a conversation it has no use for.
4. **This one: a new surface, shaped for code, sharing the domain.**

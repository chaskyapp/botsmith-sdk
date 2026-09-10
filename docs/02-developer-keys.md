# Proposal — developer keys for programmatic bot management

Status: **proposal. Nothing is built, on either side.**

Raised 2026-09-09, and corrected the same day: an earlier draft had these keys
*replacing* `X-Secret` on the existing surface. They do not. **BotSmith stays
exactly as it is.** This adds a surface rather than changing one.

---

## Three surfaces, not two

| Surface | Credential | Client | Audience |
|---|---|---|---|
| `/bot<TOKEN>/…` runtime | bot token, in the path | `@chasky/botsmith` | third parties |
| `/bot-management` (BotSmith) | human session + `X-Secret` | `@chasky/botsmith-admin` | **the portal's BFF** |
| programmatic management *(proposed)* | `sk_…` | a new package | **third parties** |

BotSmith is a conversational dialogue driven by a person in the portal. Its
credential is that person's session plus the platform secret, and that is
correct for what it is — a first-party UI talking to its own backend. Nothing
here proposes changing it.

What is missing is the other thing: **a developer administering their own bots
from code**, which today is impossible at any price. Handing a third party the
platform secret would hand them every non-public route on the API.

## What it does not change

An earlier draft of this document claimed the split in §6 of the contract and
decision D13 would be revisited. That was wrong, and worth recording as wrong.

`@chasky/botsmith-admin` stays internal, stays separate, and keeps its three
guards. It serves the portal's BFF with the portal's credential, and that does
not change because a different surface gains a different credential. The `sk_`
key would justify a **new, fourth artifact** — public, for third parties — not a
merge of two existing ones.

## What it needs from the server

All server work, none of it in the SDK:

- **Issue, list and revoke keys**, per developer, from a panel.
- **Store only a hash**, revealing the key once at creation — the discipline
  `SecretReveal` already follows for bot tokens.
- **Authenticate separately from `ValidateApiSecret`.** A developer key must NOT
  open the rest of the API; that is the whole point.
- **Scope it to the bots its owner owns.** Without scoping, an `sk_` is the
  platform secret with extra steps, and the proposal buys nothing.
- **A prefix that reads wrong in the wrong place** (`sk_`), so a key pasted into
  a browser bundle is visible in review — the property Stripe gets from
  `sk_`/`pk_`.
- Optionally: expiry, last-used timestamps and per-key audit, which are what
  make an incident diagnosable rather than total.

## Why the comparisons

**Stripe** is the close parallel: a publishable key for the browser and a secret
key for the server, in two packages, with the prefix making it obvious at a
glance which is which. That is the shape to copy.

**Telegram is no guide.** It never exposed bot administration as an API at all —
BotFather is a bot, driven by a chat, authenticated by the user's own Telegram
session. There is no platform secret to hand out because there is no programmatic
surface to hand it out for. Chasky chose to expose one, and this proposal is
about paying for that choice properly.

## Recorded as S6

In §13 of the contract, alongside the other server requests, and deliberately
apart from S2–S5: those are papercuts, and this decides whether third parties
can manage their own bots at all.

## Until then

The guards added on 2026-09-09 keep the platform secret where it belongs:

| Layer | Mechanism |
|---|---|
| Build | `exports` maps the `browser` condition to `null`, so a bundler refuses to resolve the package for a client build |
| Runtime | `assertServerOnly()` throws where both `window` and `document` exist |
| Type | `PlatformSecret` / `asPlatformSecret(...)` — a bare string is rejected, so passing it is a line that reads wrong in the wrong file |

A caller on Next.js can add a fourth by importing `server-only` in whatever wraps
the client: that breaks the **build** if a client component ever reaches it,
which is stronger than anything this package can check about itself.

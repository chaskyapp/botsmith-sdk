# Proposal — `x-chasky-dev-secret` for `/bot-management`

Status: **proposal. Nothing is built, on either side.**

Raised 2026-09-09. It changes **who can manage bots**, so it sits in front of the
packaging decisions it would undo.

> Two earlier drafts of this document got the scope wrong — one had the key
> replacing `X-Secret` everywhere, the next had it adding a separate surface and
> leaving `/bot-management` untouched. Both are recorded as wrong because the
> distinction is the whole proposal, and someone reading this later deserves to
> know it was argued rather than assumed.

---

## The change

`/bot-management` stops authenticating with `X-Secret` and authenticates with a
header of its own:

```
x-chasky-dev-secret: sk_…
```

**BotSmith's dialogue does not change.** The commands, the steps, the optimistic
concurrency on `expectedRevision`, the receipts — all of it stays. What changes
is the credential at the door.

## Why it matters more than it looks

`X-Secret` is Chasky's **global** API secret: one value, from `API_SECRET`,
checked by a middleware that guards every non-public route on the API. Putting
bot management behind it has three consequences, none of which is about bots:

1. **No third party can manage their own bots, at any price.** Giving them the
   key to this door gives them the key to every door.
2. **A leak is unattributable.** Every internal caller shares the value, so
   there is no way to know who lost it.
3. **Rotation is all-or-nothing.** Changing it means redeploying every consumer
   at once — in an incident, the fix is as disruptive as the breach.

A per-developer key removes all three, and the third-party one is the reason
this is worth doing.

## What it does to the SDK

**The admin package stops being internal.** It exists as a separate,
deliberately-named artifact today for exactly one reason: its credential was a
platform secret no third party could hold. Once the credential belongs to the
developer, managing your own bots is an ordinary third-party capability, and
`@chasky/botsmith-admin` becomes a normal public package — or merges back into
`@chasky/botsmith` as a subpath, which is where D13 started.

That decision reopens **on purpose** when this ships. It is not a reversal of the
split; the split was correct for the credential it was built around.

The three guards would also relax: `PlatformSecret` becomes `DeveloperKey`, and
the browser guard stays — an `sk_` still must not ship to a client bundle, for
the same reason Stripe's `sk_` must not.

## What it needs from the server

All server work, none in the SDK:

- **A developer panel** to issue, list and revoke keys.
- **Hash at rest, reveal once** at creation — the discipline `SecretReveal`
  already follows for bot tokens.
- **Its own middleware.** `x-chasky-dev-secret` must be checked *instead of*
  `ValidateApiSecret` for these routes, not in addition to it. If the global
  gate still applies, nothing was gained.
- **Scope to the bots its owner owns.** Without this an `sk_` is the platform
  secret with extra steps, and the proposal buys nothing. This is the
  load-bearing requirement.
- **The `sk_` prefix**, so a key pasted into a browser bundle is visible in
  review — the property Stripe gets from `sk_`/`pk_`.
- Optionally: expiry, last-used timestamps, per-key audit. These turn an
  incident from total into diagnosable.

### The open question: what happens to the portal

The portal's BFF calls `/bot-management` today with a human session plus
`X-Secret`. If the route moves to `x-chasky-dev-secret`, the portal has to move
too. Two ways:

| | How | Cost |
|---|---|---|
| **Both accepted** *(recommended)* | the route takes a session for the portal **or** an `sk_` for programmatic callers | two auth paths to keep correct, but the portal is untouched and can migrate later |
| Key only | the portal gets a key too, minted for the signed-in user | one path, but the portal has to mint and hold per-user keys, which is a product change of its own |

Recommending "both accepted" only because it decouples shipping this from
changing the portal. It is not obviously right and belongs to whoever owns the
portal.

## Why the comparisons

**Stripe** is the close parallel: `pk_` for the browser, `sk_` for the server,
in two packages, with the prefix making it obvious at a glance which is which.
That is the shape to copy.

**Telegram is no guide.** It never exposed bot administration as an API —
BotFather is a bot, driven by chat, authenticated by the user's own Telegram
session. There is no platform secret to hand out because there is no
programmatic surface to hand it out for. Chasky chose to expose one, and this is
what paying for that choice properly looks like.

## Recorded as S6

In §13 of the contract, deliberately apart from S2–S5: those are papercuts, and
this decides whether third parties can manage their own bots at all.

## Until then

The guards added on 2026-09-09 keep the platform secret where it belongs:

| Layer | Mechanism |
|---|---|
| Build | `exports` maps the `browser` condition to `null`, so a bundler refuses to resolve the package for a client build |
| Runtime | `assertServerOnly()` throws where both `window` and `document` exist |
| Type | `PlatformSecret` / `asPlatformSecret(...)` — a bare string is rejected, so passing it is a line that reads wrong in the wrong file |

On Next.js a caller can add a fourth by importing `server-only` in whatever wraps
the client: that breaks the **build** if a client component ever reaches it.

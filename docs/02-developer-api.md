# Proposal — a developer key for `/bot-management`

Status: **proposal. Nothing is built, on either side.**

Raised 2026-09-09 and reshaped four times before landing here. The earlier
versions are recorded at the end, because the differences between them are the
argument.

---

## The mechanism, which already exists

Mark the `/bot-management` group **public**, so it skips the global `X-Secret`
gate, and give that group its own middleware that validates a developer key:

```
x-chasky-dev-secret: sk_…
```

This is not a new design. It is exactly what the bot runtime already does:

```go
public := nexus.EndpointOptions{IsPublic: true, NoRequiresAuthentication: true}
server.GroupWithOptions("", []nexus.Endpoint{ /* getMe, getUpdates, … */ },
    &nexus.GroupOptions{Middlewares: []func(http.Handler) http.Handler{
        middleware.RecoverBotAPI, middleware.ResolveBotToken(resolver),
    }})
```

`IsPublic` takes the route out of `ValidateApiSecret`; the group's own
middleware puts a different credential in its place. A `ResolveDeveloperKey`
alongside `ResolveBotToken` is the same shape, in the same file, against the
same router.

## What it buys

**Third-party developers can manage their own bots from their own code**, which
today is impossible at any price: the only credential that opens the surface is
the one that opens every non-public route on the API.

And the portal is untouched. If the route accepts a session as well as a key,
the BFF keeps working exactly as it does now, and can migrate later or never.

## THE RISK, and it is not hypothetical

**`IsPublic` removes a guard. If the replacement is not there, or is
misconfigured, the route is simply open.**

This repo has already lived that failure once, and the comment in
`ValidateApiSecret.middleware.go` describes it:

> `ONE_PAY_PATH` is read with `os.Getenv` and has no default. Empty, the
> condition became `strings.HasPrefix(path, "")` — and every string has the
> empty string as a prefix, so the OnePay webhook bypass turned into a bypass of
> everything.
>
> It is the worst possible failure for an auth gate: the service answers 200,
> logs nothing unusual, and the protection simply is not there.

The same shape applies here. `IsPublic: true` plus a developer-key middleware
that fails open — an unset config, a nil resolver, an empty expected value —
does not error. It serves bot administration to anyone who asks.

So the middleware must be **fail-closed by construction**:

- Empty or missing key configuration ⇒ reject every request, never allow.
- A nil or unregistered resolver ⇒ the route must not register at all, the way
  `NewBotSmithHandler` already returns `ErrUnavailable` rather than wiring
  itself half-built.
- A test that asserts the route rejects an **absent** header, not only a wrong
  one. Absence is the case that silently passes when a check is skipped.

## What else the server needs

- **A developer panel** to issue, list and revoke keys.
- **Hash at rest, reveal once**, the discipline `SecretReveal` already follows
  for bot tokens.
- **Scope every route to the key's owner.** Load-bearing: without it an `sk_` is
  the platform secret with extra steps. `botsmith` already binds ownership to
  the authenticated actor — the key has to resolve to that same actor, not
  bypass it.
- **The `sk_` prefix**, so a key pasted into a browser bundle is visible in
  review — what Stripe gets from `sk_`/`pk_`.
- Optionally: expiry, last-used timestamps, per-key audit. These make an
  incident diagnosable instead of total.

## What it does to the SDK

`@chasky/botsmith-sdk-admin` **becomes a public package for third parties.** Its
credential stops being the platform's and starts being the developer's, so the
reason it was split off disappears. D13 reopened on purpose — either an ordinary
public package, or folded back into the runtime as a subpath, which is where D13
started — and closed as **D14**: it stays a separate package, because
administration follows the server's deltas and the runtime does not.

The guards change rather than vanish. `PlatformSecret` becomes `DeveloperKey`;
`assertServerOnly()` **stays**, because an `sk_` must not reach a browser bundle
either — the same rule Stripe's secret key lives under.

### One thing the SDK should absorb: the dialogue is a conversation

Creating a bot through `/bot-management/commands` is four chained POSTs carrying
conversational state:

```
{command: "/newbot", expectedRevision: 0}
{command: "value", value: "MyBot", expectedRevision: 1}
{command: "value", value: "mybot", expectedRevision: 2}
{command: "confirm",  expectedRevision: 3}
```

That is right for a person typing in a portal and wrong for a CI job. Since the
routes are not changing, **the SDK is where that gets fixed**: a facade that
exposes one call and drives the conversation underneath.

```ts
await admin.createBot({ name: "MyBot", username: "mybot" });
```

Absorbing protocol friction is what an SDK is for — it is the same job as the
offset arithmetic and the idempotency keys in the runtime. Two costs to state
plainly rather than hide:

- **It is still four round trips.** Fine for provisioning, not for a hot path.
- **`expectedRevision` is a real CAS.** Two callers driving the dialogue at once
  produce `STALE_STATE`, and the facade has to re-read and retry. That is a
  behaviour worth its own conformance case before it is written.

## What is waiting on this

S6 is implemented server-side (chaskyapp/backend-api-go#527). What remains is a
live run of the administration surface against a deployed instance, and it
happens outside this repository, which ships no examples and no smoke programs.

That matters because a live run is what found `chat.id` carrying `bot:` twice, a
shape six conformance cases would otherwise still be asserting wrongly. The admin
cases have not had that test yet.

## Recorded as S6

In §13 of the contract, deliberately apart from S2–S5: those are papercuts, and
this decides whether third parties can manage their own bots at all.

## How this proposal changed

Kept because the distinctions are the substance.

1. **`sk_` replaces `X-Secret` everywhere.** Wrong: `X-Secret` guards the whole
   API, not just this.
2. **A separate surface; `/bot-management` and its credential untouched.** Wrong
   in the other direction — it left the actual problem unsolved.
3. **`/bot-management` moves onto the developer key.** Right, but described as
   swapping a credential, which implied dragging the portal along.
4. **New `/developer/…` routes, shaped for code.** Better ergonomics, but new
   server surface for something the existing routes already do.
5. **This one:** mark the existing group public and give it its own middleware —
   the pattern the runtime already uses — and put the ergonomics in the SDK,
   where they cost nothing on the server.

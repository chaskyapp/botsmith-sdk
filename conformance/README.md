# Conformance suite

The **executable source of truth** for the contract. These cases turn the
guarantees in §8 of [`../docs/00-spec.md`](../docs/00-spec.md) from prose into
tests that fail.

Each SDK brings its own runner; **the cases are shared**. Format:
[`SCHEMA.md`](SCHEMA.md).

## The rule

> A behaviour change is written as a case first, and implemented second.

A case that only passes in one language is either a badly written case or a bug
in the other two. It is never "that's how it works in that language."

And the corollary worth accepting up front: when the Go SDK lands and a case
fails, **the first hypothesis is that the case is wrong**, not Go. Cases born
from a single implementation describe that implementation. That shakeout is why
Go ships second.

## Coverage

| Case | Pins |
|---|---|
| `g2-offset-advances-when-handler-throws` | The offset is a read cursor, not a business ack |
| `g3-redelivered-update-runs-handler-once` | At-least-once delivery, deduplicated client-side |
| `g3-recreated-group-redelivers-whole-stream` | Threshold vs finite window — the window fails here |
| `g4-fresh-key-per-logical-message` | A reused key makes the server discard the second message *silently* |
| `g4-same-key-when-retrying-one-message` | A retry with a fresh key is not a retry, it is a duplicate |
| `g5-transport-error-does-not-leak-the-token` | The token is in the path, so errors are born contaminated |
| `g6-timeout-clamped-to-server-maximum` | A reasonable value must not become a 400 |
| `g7-401-stops-the-bot` | Terminal means terminal |
| `g7-500-retries-with-backoff` | The mirror: transient means retry |
| `g7-409-stops-and-sends-nothing-more` | Retrying a 409 is an eviction war |
| `g9-identifiers-are-re-emitted-verbatim` | Ids are strings; every coercion is a silent error |

The three `g7-*` cases and the two `g4-*` cases are **pairs on purpose**. A single
case can be satisfied by an SDK that is wrong in the opposite direction — one that
retries everything passes `g7-500`, one that stops on everything passes `g7-401`.
The pair is what pins the boundary.

## Validating a runner

`js/conformance/fixtures/naive-bot.ts` is a deliberately naive bot: the offset
advances only on success, no deduplication, one idempotency key forever, no
redaction, no clamping, retry everything including 401 and 409.

Cases must fail against it **for their own reason**, and the useful expectation is
not "all of them fail" — it is that each case fails exactly when its guarantee is
violated and passes when it is not. The naive bot violates G2, G3, G4, G5, G6 and
G7, so those cases fail; it happens to re-emit identifiers correctly and to retry
a 500 correctly, so `g9-*` and `g7-500-*` pass. **That split is the better
signal**: a suite that rejects everything is as useless as one that accepts
everything, and only a mixed result shows it discriminates.

## What a runner must guarantee

Learned the first time the runner met a broken SDK, and binding on the Go and
Python runners too:

- **Isolate the code under test.** A conformance runner executes untrusted code
  by definition — an SDK with a bug is the entire point. An unhandled exception
  from the bot must fail *that case* and let the suite continue. When the JS
  runner first ran, a fixture crash killed the process at case 5 of 11 and hid
  the remaining 6: precisely the moment the report matters most.
- **Answer unexpected requests, do not hang on them.** When the SDK sends
  something past the last exchange, record it *and* reply. Leaving it to time out
  makes the case fail on a timeout, which hides *which* request was the extra one.
- **Answer every method, not just the ones in use.** Python's fake was built on
  `BaseHTTPRequestHandler`, which dispatches by method name and answers 501 for
  anything without a `do_*`. Only `do_POST` existed, so every `GET` in a case
  came back "Not Implemented" — and nothing noticed for fifteen cases, because
  the entire runtime suite is POST-only. The first case that read the dialogue
  found it.
- **Redact before printing.** The runner prints paths, and paths carry the token.
- **Group repeated failures.** Five identical "unexpected request" lines are
  noise; a count with the first few is information.

## Coverage of the guarantees

Every guarantee in §8 of the contract now has at least one case, and so does
every management requirement. The two that were open longest are worth naming,
because closing them is what the format grew for:

- **G1** makes no HTTP request at all — a second `start()` must fail locally.
  The case says `bot.startTwice`, and the runner reports whether the second call
  was rejected.
- **G8** needed the runner to interrupt the bot rather than watch it. The case
  says `run.stopAfterMs`, and the fake holds its response for five seconds so
  that a `stop()` which waits it out is unmistakable.

Both were listed as known gaps for most of this suite's life, on the grounds
that the format could not express them. It could not — until a case needed it,
which is the right moment to grow a format rather than the moment someone
imagines the need.

## Still not covered

- **`getWebhookInfo` has no case.** The format can invoke methods on the *admin*
  client (`kind: "management"`, `calls`) but has no equivalent for the runtime's
  raw client — the runtime adapter exposes a bot's lifecycle, not its methods.
  Covering it means either a third case kind or widening `calls` to reach the raw
  client. Left undone deliberately: the same rule that kept `run.stopAfterMs`
  out until a case needed it. Now one does, so this is the next thing the format
  should grow.


**The management smokes have never met a real server.** S6 has shipped on the
server side, so running them is now the closing step of that delta (DK-T8).

Conformance proves them against a fake that answers what the six `m*` cases
declare; only a live run proves those cases describe the real thing. That is the
gap that found `chat.id` carrying `bot:` twice on the runtime side, and it is
still open here.

They were deferred while the only way in was a session plus `X-Secret`: that
would have exercised a credential S6 replaces, and required the platform secret
in a `.env`. With developer keys they need one credential, `CHASKY_DEV_KEY`,
issued from BotSmith.

**The change was larger than "one line each", which this file used to promise.**
The clients sent `X-Secret` *and* a bearer. With a key, sending the bearer too is
a 401 — the server rejects two credentials rather than choosing — so swapping the
header alone would have broken every call. Each client now takes exactly one
credential and refuses both at construction, and case `m1` asserts
`Authorization: $absent` next to the key. The calls, the shapes the smokes print
and the read-only default stayed.

## A note on what these cases assume

The exchange lists are exhaustive, so writing them forced a design decision worth
naming: **the runtime does not send `sendChatAction` on its own.** Typing is a
product decision — whether it helps depends on how long your bot takes — and the
author calls `ctx.typing()` when they want it. A runtime that sent it
automatically would double every bot's request count, including bots that answer
in five milliseconds where the indicator is just flicker.

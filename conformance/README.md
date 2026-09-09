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

## Known gaps

Declared rather than left to be noticed later:

- **G1 (one in-flight poll per instance)** — calling `start()` twice is a local
  error that makes no HTTP request, so it is a per-SDK unit test, not a case here.
- **G8 (clean cancellation)** — needs the runner to call `stop()` mid-flight,
  which the format does not express yet. Covering it means adding a
  `run.stopAfterMs` field to [`SCHEMA.md`](SCHEMA.md); left out until the first
  runner exists, so the format grows against a real need instead of a guess.
- **The management surface** has no cases yet. It ships after the runtime, and
  its cases come with it.

## A note on what these cases assume

The exchange lists are exhaustive, so writing them forced a design decision worth
naming: **the runtime does not send `sendChatAction` on its own.** Typing is a
product decision — whether it helps depends on how long your bot takes — and the
author calls `ctx.typing()` when they want it. A runtime that sent it
automatically would double every bot's request count, including bots that answer
in five milliseconds where the indicator is just flicker.

# Conformance suite

**Empty: no cases yet.** This is the first thing that gets written, before any
SDK.

The cases under `cases/` are the **executable source of truth** for the contract:
they turn guarantees G1–G9 (§8) into tests that fail. Each SDK brings its own
runner; **the cases are shared**.

## The rule

> A behaviour change is written as a case first, and implemented second.

A case that only passes in one language is either a badly written case or a bug
in the other two. It is never "that's how it works in that language."

And the uncomfortable corollary, worth accepting up front: when the Go SDK lands
and a case fails, **the first hypothesis is that the case is wrong**, not Go.
Cases born from a single implementation describe that implementation. That shakeout
is exactly why Go ships second.

Details and the priority case list:
[`../docs/01-organizacion.md`](../docs/01-organizacion.md) §4 *(in Spanish for now)*.

# Go SDK

**Delivery 2. Empty: no code yet.**

- Module: `github.com/chaskyapp/botsmith-sdk/go`, `package chaskybot`. The package name
  does not match the directory on purpose — `package go` is not a thing.
- Release tags carry the **subdirectory prefix**: `go/v0.1.0`, not `v0.1.0`.
  Without the prefix, `go get` fails in a confusing way.
- Management lives at `.../botsmith-sdk/go/management`, a separate package in the
  same module. Shared internals live under `internal/`, so neither surface can
  reach into the other.
- It is written **looking at** `reference/pepibot/`, not derived from it: pepibot
  runs against Chasky and Telegram at once, and that is its whole value. See §5.4
  of the contract.
- Contract: [`../docs/00-spec.md`](../docs/00-spec.md) *(in Spanish for now)*

# Go SDK

**Delivery 2. Empty: no code yet.**

- Module: `github.com/chaskyapp/botsmith-sdk/go`, `package chaskybot`. The package name
  does not match the directory on purpose — `package go` is not a thing.
- Release tags carry the **subdirectory prefix**: `go/v0.1.0`, not `v0.1.0`.
  Without the prefix, `go get` fails in a confusing way.
- The import path has **no `chasky-` prefix**, and that is deliberate. A Go module
  path must match the URL the repo actually lives at, so the path is fixed by the
  repository name — and the organization already says `chaskyapp`, exactly as in
  `github.com/chaskyapp/backend-api-go`. Adding the prefix would say *chasky*
  twice and would require renaming the repository to match.
- Management lives at `.../botsmith-sdk/go/management`, a separate package in the
  same module. Shared internals live under `internal/`, so neither surface can
  reach into the other.
- It is written **looking at** `reference/pepibot/`, not derived from it: pepibot
  runs against Chasky and Telegram at once, and that is its whole value. See §5.4
  of the contract.
- Contract: [`../docs/00-spec.md`](../docs/00-spec.md)

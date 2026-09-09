# Go SDK

**Delivery 2. Implemented; conformance runner in `conformance/`.**

- Module: `github.com/chaskyapp/botsmith-sdk/go`, `package chaskybot`. The package
  name does not match the directory on purpose — `package go` is not a thing.
- Release tags carry the **subdirectory prefix**: `go/v0.1.0`, not `v0.1.0`.
  Without the prefix, `go get` fails in a confusing way.
- The import path has **no `chasky-` prefix**, and that is deliberate. A Go module
  path must match the URL the repo actually lives at, so the path is fixed by the
  repository name — and the organization already says `chaskyapp`, exactly as in
  `github.com/chaskyapp/backend-api-go`. Adding the prefix would say *chasky*
  twice and would require renaming the repository.
- Zero dependencies: standard library only.

## Running conformance

```bash
go test ./conformance/ -v
```

It reads the **same** cases as the TypeScript SDK, from `../conformance/cases`.
Where the TypeScript runner is a CLI, this is a test — that is what a Go
developer runs. Same cases, same verdicts, different shape.

`TestRunnerDetectsAMismatch` keeps the runner honest: it takes a passing case,
makes one expectation impossible, and requires the runner to notice. A runner
that has never failed a case is not a tested runner.

## Smoke test against a real server

```bash
cp ../.env.example ../.env    # then fill in the token
go run ./cmd/smoke
```

Conformance proves the SDK against a fake that answers what the cases declare.
This proves the other half: that the cases describe the **real** server. It
checks `getMe` — the one method no case exercises — and prints the wire shape of
the first update once, so the assumptions eleven cases rest on meet the server.

## Shape

The guarantees are identical to the TypeScript SDK; the shape is Go's.

| | TypeScript | Go |
|---|---|---|
| Cancellation | `AbortSignal` | `context.Context` |
| Terminal failure | `onFatal` callback | returned by `Run` |
| Errors | exceptions | error values, `errors.As` |
| Handlers | `bot.on("text", fn)` | `bot.Handle(func(ctx, e) error)` |
| Entry point | `await bot.start()` | `bot.Run(ctx)` blocks |

`Run` returning the terminal error is why this SDK has no `OnFatal`: in Go, an
error that ends the loop belongs in the return value.

- Contract: [`../docs/00-spec.md`](../docs/00-spec.md)
- Invariant vs idiomatic: [`../docs/01-organization.md`](../docs/01-organization.md) §3

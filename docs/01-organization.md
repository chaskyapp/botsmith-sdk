# Monorepo organization

Companion to [`00-spec.md`](00-spec.md), which defines **the contract**. This
document defines **how that contract survives three implementations without them
drifting apart.**

Closed decisions: monorepo, and the delivery order **TypeScript → Go → Python**.

---

## 1. The problem this document solves

Writing three SDKs is not hard. Keeping them **the same SDK** six months from now
is.

The concrete failure mode: someone fixes offset advancement in TypeScript —
because a user reported their bot getting stuck — and Python and Go keep the bug.
Now there are two behaviours against the same server, neither documented as
different, and the next person to investigate loses a day working out which of
the three is right.

That risk is not managed with goodwill or a checklist in the PR template. It is
managed with **an executable conformance suite** (§4) and a clear rule about what
must be identical and what must differ (§3).

The repo layout is the **least** important thing in this document. It comes first
because it is what you see.

---

## 2. Layout

```
botsmith-sdk/
├── README.md
├── docs/
│   ├── 00-spec.md              The contract. Language-agnostic.
│   └── 01-organization.md      This document.
├── conformance/
│   ├── README.md               How to run it and how to add a case.
│   └── cases/                  Declarative cases. Executable source of truth.
├── js/                         @chasky/botsmith (+ /management)   · delivery 1
│   └── core/                   Internal, NEVER published. See 00-spec.md §6.
├── go/                         .../botsmith-sdk/go (+ /management) · delivery 2
│   └── internal/               Internal, not importable from outside.
├── python/                     chasky_botsmith (+ .management)    · delivery 3
│   └── _core/                  Internal by convention.
└── reference/
    └── pepibot/                Conformance client (D5)
```

**A note on the name**: `BotSmith` names the **whole bot product**, which is why
it names both the repo and the publishable artifact. In the server repo,
`botsmith` names something else — the management surface, `/bot-management` — so
the two senses coexist across repos and it is worth keeping in mind when jumping
between them.

Each language publishes **one** artifact with **two entrypoints** — runtime at the
root, management under `/management` — and keeps what little they share in an
**internal, unpublished** module. Sharing an artifact does not make them one
thing: requirements R-A to R-D in §6 of the contract are what hold the real
separation, and the reason is not tidiness — the envelopes are incompatible and
`409` means the opposite on each surface. That internal module **must not expose
one surface to the other**; if it starts growing, that is a sign something meant
to stay separate is leaking.

**One directory per language at the root, not under `sdk/`.** The extra nesting
buys nothing and makes Go's tags worse: `go/v0.1.0` is readable, `sdk/go/v0.1.0`
is noise. The price is a root with three implementation directories in plain
sight, which is exactly what the repo is.

### The Go details, which are the only awkward ones

Go is the ecosystem that handles polyglot monorepos worst, so these are worth
writing down before someone discovers them alone:

- `go/go.mod` declares `module github.com/chaskyapp/botsmith-sdk/go`.
- The import is `github.com/chaskyapp/botsmith-sdk/go`, and the package is called
  `chaskybot` — in Go the package name need not match the directory, and
  `package go` does not exist.
- Release tags carry the subdirectory prefix: **`go/v0.1.0`**, not `v0.1.0`. It
  is Go's standard submodule mechanism, it works with `go get`, and it fails
  confusingly if someone tags without the prefix.
- **The import carries no `chasky-` prefix, and that is deliberate.** A Go module
  path must match the URL the repo actually lives at — otherwise `go get` fails
  with *"module declares its path as X but was required as Y"* — so the path is
  fixed by the repository name and is not chosen separately. And the organization
  already says `chaskyapp`, exactly as in `github.com/chaskyapp/backend-api-go`:
  adding the prefix would say *chasky* twice and would require renaming the repo.

  The clarification earns its place because on PyPI the prefix **is** needed
  (`chasky_botsmith`, since PyPI has no namespaces) and that invites a wish for
  symmetry. The symmetry already exists: all three say "chasky" — npm puts it in
  the scope, Go in the organization, and PyPI in the name, because it is the only
  one with nowhere else to put it.
- `go/` has its own `go.sum` and its own CI. It shares no build machinery with the
  other two.

None of these is an obstacle. All of them are surprises if not anticipated.

---

## 3. What is invariant and what is idiomatic

**The most important rule in the repo.** The classic multi-language SDK mistake is
**transliteration**: porting TypeScript to Python by changing the syntax. The
result is recognisable at a glance — `bot.onError(...)` in camelCase, with
callbacks, in a PyPI package — and it tells the user they were sold a lazy port.

A Python SDK has to feel like it was written by someone who writes Python.

### Invariant — identical across all three, and conformance verifies it

- Guarantees **G1–G9** and delegations **L1–L5** from §8 of the contract, with the
  same **observable behaviour**: same requests, same order, same retries, same
  hard stops.
- The **names of the domain types and their fields** (`Update`, `BotMessage`,
  `chat`, `from`, `text`). Adjusted to each language's convention, but
  recognisable: whoever reads the spec finds the field.
- **Error classification** — terminal / business / transient — and what gets
  retried.
- The token **redaction policy** (§10.3): no exposed object contains the
  credential, in any of the three.
- The **exact wire format**: what is sent, with which headers, with which
  defaults.

### Idiomatic — different on purpose, and conformance does not look at it

| | TypeScript | Go | Python |
|---|---|---|---|
| Concurrency | `Promise` + `AbortSignal` | goroutine + `context.Context` | `asyncio` + `CancelledError` |
| Naming | `camelCase` | exported `PascalCase` | `snake_case` |
| Errors | exceptions (`throw`) | error values (`error`) | exceptions (`raise`) |
| Handlers | closures, `bot.on("text", fn)` | funcs / interfaces, `bot.Handle(...)` | decorators, `@bot.on_text` |
| Config | options object | functional options | kwargs / dataclass |
| Cancelling | `bot.stop()` with `AbortController` | cancel the `context` | cancel the task |

When invariant and idiomatic collide, **idiomatic wins on shape and invariant wins
on behaviour**. A concrete example: in Go, `sendMessage` returns
`(BotMessage, error)` and throws nothing — that is idiomatic and correct. What
**cannot** change is which of those errors the SDK retries on its own and which it
returns.

---

## 3 bis. Language

**Everything in this repo is in English** — code, comments, error messages,
READMEs, conformance cases, documentation and commit messages. The SDK's audience
is international, and a package on npm or PyPI with Spanish comments is
indefensible.

The specs were drafted in Spanish while decisions were still open, and translated
on 2026-09-09 once they closed (D12, §12 of the contract). The only Spanish left
in the repo is the first three commit messages: rewriting history costs more than
it is worth.

**Rule for settling doubts**: if someone outside the team reads it, it is in
English. That covers essentially everything the repo produces.

---

## 4. The conformance suite

This is the mechanism that keeps "three SDKs" from becoming "three products".
Without it, §3 is an aspiration.

### What it is

A set of **declarative cases** in `conformance/cases/`, versioned alongside the
contract. Each case describes a server scenario and the requests the SDK **must**
produce. It turns guarantees G1–G9 from prose into tests that fail.

The cases that matter most are the ones matching the six traps in §3, because
those are what a rushed port breaks:

- The server returns updates 5, 6, 7 and the handler **throws** on 6 → the next
  poll sends `offset: 8`. **G2.** The easiest one to break, because "I only
  acknowledge what I processed correctly" sounds right.
- The server redelivers update 6 → the handler runs **exactly once**. **G3.**
- The consumer group is recreated and the server redelivers **the entire stream**
  → no handler runs again. **G3.** This is the case that separates a threshold
  from a finite window: the window fails here (D6, §12 of the contract).
- Two logically distinct `sendMessage` calls → **two different**
  `Idempotency-Key` values. **G4.** And retrying the first → the **same** key.
- The transport fails with an error containing the URL → the error leaving the SDK
  does **not** contain the token. **G5.**
- `timeout: 60` → the request goes out with the server's maximum, not 60. **G6.**
- `401` → the bot stops and does not retry. `500` → retries with backoff. **G7.**
- `409 CONFLICT_POLLING` → the bot stops and sends **not one more poll**. **G7.**
  This is the cheapest one to break and the most expensive to diagnose: an SDK
  that retries the `409` puts two instances into an eviction war where neither
  processes anything. The case must verify **zero subsequent requests**, not just
  that the error was reported.

### How it runs

Each SDK brings a minimal runner that stands up a fake HTTP server driven by the
case, runs the SDK against it, and compares observed requests against expected
ones. The runner is per language; **the cases are shared**.

A case that only passes in TypeScript is either a badly written case or a bug in
the other two. It is never "that's how it works in that language."

### The operating rule

> **A behaviour change is written as a conformance case first, and implemented
> second.** An SDK that does not pass a new case is incomplete, not broken: the
> case is what rules.

And the uncomfortable corollary, worth accepting up front: when the Go SDK lands
and a case fails, **the first hypothesis is that the case is badly written**, not
that Go is wrong. Cases born from a single implementation describe that
implementation. That shakeout is exactly why Go goes second (§5.2 of the
contract), and it should not be resisted: it is the work, not a setback.

---

## 5. Versioning and releases

**Closed as D11**: independent version per language, with the contract version
declared separately.

- Each language's artifact has its own semver. A packaging fix in Python does not
  force an empty release of TypeScript and Go.
- Each artifact declares **which contract version** it satisfies, and that number
  appears in conformance. It is the fact that answers the question that actually
  matters: *does this SDK implement the same guarantees as that one?*
- Tags: `js/v0.1.0`, `go/v0.1.0`, `python/v0.1.0`.

The alternative — a single synchronised version for all three — is easier to
explain and to communicate. It is paid for with empty releases and with a version
that lies about what changed in each artifact.

---

## 6. Work order

The order **within** each delivery matters as much as the order between
languages.

### Delivery 1 — TypeScript

1. ~~Close the contract's decisions.~~ **Done**: all thirteen are resolved.
2. Write the conformance cases **before** the SDK. They come from §8 of the
   contract, not from the implementation.
3. ~~TypeScript conformance runner.~~ **Done**, and validated: 2/11 against the
   naive fixture, so the suite is known to discriminate rather than rubber-stamp.
4. ~~`@chasky/botsmith`: raw client, then runtime.~~ **Done**: 11/11 conformance.
5. ~~Run against a real local server, with pepibot's full flow.~~ **Done, and
   later repeated for Go and Python.** Conformance proves an SDK against a fake
   that answers what the cases declare; only a real server proves the cases
   describe the real one — which is how the doubled `bot:` prefix in `chat.id`
   was found (§9 of the contract). All three now print the same wire shape
   against the same server.

### Delivery 2 — Go

6. ~~Move `~/Desktop/pepibot/` into `reference/pepibot/` and translate its
   comments to English (D5).~~ **Done.** Copied rather than moved: the original on
   the Desktop is the author's to delete. From here the repo copy is the one that
   is maintained.
7. ~~`botsmith-sdk/go`~~ **Done.**
8. ~~Go conformance runner, against the same cases.~~ **Done**: 11/11, first run,
   with no case edited. `TestRunnerDetectsAMismatch` proves that runner checks.
9. **Reconcile.** Nothing to reconcile: no case turned out ambiguous.

   That is a weaker result than it looks, and worth writing down honestly. Both
   ports were written by the same author holding the same reading of the
   contract, so the cross-check mostly proves the cases are **portable and
   executable from two independent runners** — not that the contract is
   complete. A third party writing the Go port would have been the stronger
   test. What did hold up: the guarantees are expressible without depending on
   one language's shape, and nothing in the case format leaked TypeScript.

### Delivery 3 — Python

10. ~~`chasky_botsmith`, with the contract already shaken out by two ports.~~
    **Done.**
11. ~~Runner and conformance.~~ **Done**: 11/11, no case edited. The runner is
    `unittest` — stdlib, so checking the SDK installs nothing beyond `httpx`.

    Third port, same result as the second: nothing ambiguous surfaced. The same
    caveat applies as in step 9 — one author, one reading of the contract — but
    three ports agreeing on eleven cases does establish that the guarantees are
    expressible without borrowing any one language's shape. The three chose three
    different ways to report a terminal failure (a callback, a return value, an
    exception) and the suite did not care, which is the clearest evidence that
    the cases test behaviour rather than form.

### Cross-cutting, any time

12. The server requests in §13 of the contract. S1 is already resolved; S2 to S5
    are minor and depend on no SDK, so they can move in parallel with delivery 1.

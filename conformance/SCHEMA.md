# Conformance case format

A case is a single JSON file under `cases/`. It is **data, not code**: every
runner reads the same file and no runner may contain case-specific logic.

## Shape

```jsonc
{
  "id":              "g2-offset-advances-when-handler-throws",  // = filename
  "contractVersion": "1.0",
  "guarantee":       "G2",              // which §8 guarantee this pins down
  "title":           "One-line summary",
  "why":             "What breaks in the real world if this fails.",

  "bot": {
    "transport": "polling",
    "options":   { "limit": 50, "timeoutSeconds": 25 },
    "handler":   { "kind": "reply", "throwOnUpdateIds": [6] }
  },

  "exchanges": [
    {
      "expect":  { "method": "POST", "path": "/bot{token}/getUpdates",
                   "body": { "offset": 0 } },
      "respond": { "status": 200, "body": { "ok": true, "result": [] } }
    }
  ],

  "assert": { "botStopped": false },
  "run":    { "timeoutMs": 3000 }
}
```

## `exchanges` — the core idea

One array, in order. Each entry says **what request is expected next** and **what
the fake answers**. Two consequences worth stating, because they are what make
the format work:

1. **The list is exhaustive.** A request the SDK makes beyond the last exchange
   **fails the case**. This is what lets `g7-409-*` assert "not one more poll"
   with no special syntax: the case simply ends.
2. **Order is explicit.** Exchange *n* must be the SDK's *n*-th request. Any
   reordering is a failure.
3. **`"repeat": true` on the LAST exchange marks the idle steady state.** A bot
   that is still alive keeps long-polling forever, and those polls are correct
   behaviour — without this, every non-terminal case would fail for a reason that
   is an artifact of the format rather than a defect in the SDK. Polls past the
   list must still match that last expectation: the bot may idle, but it may not
   idle *differently*.

   Terminal cases (`g7-401`, `g7-409`) deliberately omit `repeat`, so
   exhaustiveness still catches a bot that should have stopped and did not. **The
   presence or absence of `repeat` is how a case declares whether the bot is
   supposed to survive it.**

### `expect`

- `method`, `path` — `path` may contain `{token}`, substituted by the runner.
- `body` — **partial match**: declared fields must match, undeclared fields are
  ignored. Use `"$absent"` to require a field is missing.
- `headers` — same partial-match rule, header names case-insensitive.

### `respond`

- `status`, `body` — sent verbatim.
- `transportError` — instead of a response, the fake fails the connection. The
  string is the error text, and it may contain `{url}` so a runner can reproduce
  the real-world case where the client library embeds the full URL (G5).
- `delayMs` — hold the response, for timeout and cancellation cases.

## Value matchers

Anywhere inside `body` or `headers`:

| Matcher | Meaning |
|---|---|
| a literal | must equal it |
| `"$any"` | present and non-empty, value irrelevant |
| `"$absent"` | **the key must not appear at all.** An explicit `null` VIOLATES it |
| `"$capture:name"` | matches anything non-empty and remembers it as `name` |
| `"$same:name"` | must equal a previously captured `name` |
| `"$notSame:name"` | must be non-empty and differ from `name` |

Capture/same/notSame is what makes G4 expressible: a fresh `Idempotency-Key` per
logical message, the same one on a retry.

**`$absent` is about the key, not the value**, and the distinction is the whole
point of `m1`: the server rejects an explicit `null` even where a field is
optional, so "present and null" is a failure, not a synonym for absent.

This was ambiguous in the first draft, and all three runners read it differently
— JavaScript failed correctly on a `null`, while Go and Python decoded it to
`nil`/`None` and treated it as absent. Two runners silently accepted the exact
mistake the case exists to catch. It only surfaced with the third port, which is
what §5.2 of the contract predicted and the first two ports had not yet shown.

## `bot.handler`

Handler behaviour has to be declarative, because a JSON file cannot carry a
function. The vocabulary is deliberately tiny; grow it only when a case needs it.

| Field | Meaning |
|---|---|
| `kind` | `"reply"` (answer every text), `"noop"` (consume, do not answer) |
| `throwOnUpdateIds` | update ids on which the handler raises |
| `replyText` | text to send; defaults to echoing the received text |

## `assert`

Everything that is not an observed request.

| Field | Meaning |
|---|---|
| `botStopped` | whether the bot stopped on its own by the end of the run |
| `handlerRuns` | `[{ "updateId": N, "times": M }]` — exact run counts |
| `errorsReported` | `[{ "code": N, "notContains": "..." }]` — errors surfaced to the author |
| `warnings` | `[{ "contains": "..." }]` — warnings emitted (G6, D8) |

`notContains` is how G5 is pinned: the case asserts the token string never
appears in anything the SDK hands back.

## `run`

- `timeoutMs` — hard ceiling for the whole case. The runner stops the bot and
  evaluates.

The run ends when the exchange list is exhausted **and** the SDK is idle, or when
the bot stops on its own, or at `timeoutMs`. Whichever comes first.

## Management cases

The runtime is a loop; management is REST with optimistic concurrency. A case
for it declares **which methods to invoke, in order**, instead of starting a bot
and waiting.

```jsonc
{
  "id":   "m1-omits-optionals-never-sends-null",
  "kind": "management",              // absent means "runtime"
  "calls": [
    { "method": "command",
      "args": { "command": "/newbot", "expectedRevision": 0 } }
  ],
  "exchanges": [ /* same shape as a runtime case */ ],
  "assert": { "errorsReported": [] }
}
```

- `calls[].method` is the client method: `capability`, `bots`, `bot`,
  `dialogue`, `command`, `grant`.
- `calls[].args` are its named arguments, as the SDK exposes them.
- `exchanges` and the matchers work exactly as above. `repeat`, `handlerRuns`
  and `botStopped` do not apply: nothing polls.

Management adds four assertion fields:

| Field | Meaning |
|---|---|
| `errorsReported[].managementCode` | the string code from the envelope (`STALE_STATE`, …) |
| `errorsReported[].retryable` | whether re-reading and retrying is the right response |
| `errorsReported[].accessLost` | whether this means administration was revoked |
| `secretReturnedOnce` / `secretNotIn` | the revealed token reaches the return value and nowhere else |

`retryable` and `accessLost` look like they break the rule against asserting
anything idiomatic, and they would if a case named an error class. They do not:
each SDK's **adapter** translates its own representation into those two
booleans, exactly as it already translates an error code today. The case states
the semantics the contract requires; how a language spells them stays its own
business.

### Why these cases exist at all

Most of G1-G9 belong to the runtime's loop. Management needs far fewer cases,
but the ones it needs are load-bearing, because the server's decoder is strict
in ways that are easy to violate differently in each language:

- **An optional field is omitted, never sent as `null`.** The server rejects a
  `null` even where the field is optional, and every language defaults
  differently — Python serialises `None` as `null`, JavaScript drops `undefined`
  but keeps `null`, Go omits a nil pointer with `omitempty`. One case pins it
  for all three.
- **Unknown and duplicate fields are rejected**, so an SDK must not "helpfully"
  add anything to a body.
- **`409 STALE_STATE` is retryable after re-reading**, while `409` on the
  runtime means stop. Same number, opposite instruction — that is why the two
  surfaces have separate error types (R-B in §6 of the contract).

## Rules for writing cases

1. A case pins **one guarantee**. If it needs two, it is two cases.
2. `why` states what breaks in production, not what the code does. It is the
   field that survives when someone wants to delete the case.
3. Never assert something idiomatic (naming, concurrency shape, error class
   names). Cases verify **observable behaviour** only — see §3 of
   `../docs/01-organization.md`.
4. A behaviour change is written here **first**, then implemented.

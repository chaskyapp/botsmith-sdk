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
| `"$absent"` | the field must not be present |
| `"$capture:name"` | matches anything non-empty and remembers it as `name` |
| `"$same:name"` | must equal a previously captured `name` |
| `"$notSame:name"` | must be non-empty and differ from `name` |

Capture/same/notSame is what makes G4 expressible: a fresh `Idempotency-Key` per
logical message, the same one on a retry.

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

## Rules for writing cases

1. A case pins **one guarantee**. If it needs two, it is two cases.
2. `why` states what breaks in production, not what the code does. It is the
   field that survives when someone wants to delete the case.
3. Never assert something idiomatic (naming, concurrency shape, error class
   names). Cases verify **observable behaviour** only — see §3 of
   `../docs/01-organization.md`.
4. A behaviour change is written here **first**, then implemented.

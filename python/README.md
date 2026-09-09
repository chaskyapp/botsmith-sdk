# `chasky-botsmith` — Python SDK

**Delivery 3.** Implemented; conformance runner in [`conformance/`](conformance/).

It arrives last, with the contract already shaken out by two implementations —
which makes it the cheapest of the three, not the least important.

## Shape

The guarantees are identical to the other two SDKs; the shape is Python's.

| | TypeScript | Go | Python |
|---|---|---|---|
| Concurrency | `AbortSignal` | `context.Context` | `asyncio` |
| Terminal failure | `onFatal` callback | returned by `Run` | **raised** |
| Handlers | `bot.on("text", fn)` | `bot.Handle(fn)` | `@bot.on_text` |
| Entry point | `await bot.start()` | `bot.Run(ctx)` | `await bot.run()` |
| Conformance | a CLI | `go test` | `unittest` |

There is no `on_fatal`: in Python an error that ends the loop is an exception,
and callers already know how to handle one. Cancel the task to stop the bot.

```python
bot = Bot(token=os.environ["CHASKY_BOT_TOKEN"])

@bot.command("start")
async def start(event: Event) -> None:
    await event.reply("Hello.")

@bot.on_text
async def echo(event: Event) -> None:
    await event.reply(f"You said: {event.message.text}")

await bot.run()
```

## The one dependency

`httpx`, and it is not reached for lightly. Go and Node ship async HTTP in their
standard library; Python does not. The alternative is `urllib` on a thread pool,
and a 30-second long poll blocking a thread with poor cancellation is worse than
one well-maintained dependency.

The conformance runner, by contrast, is **stdlib only** — its fake server is
`http.server` on a thread — so checking the SDK installs nothing beyond `httpx`.

## Smoke test against a real server

```bash
cp ../.env.example ../.env    # then fill in the token
.venv/bin/python smoke.py
```

Conformance proves the SDK against a fake that answers what the cases declare.
This proves the other half: that the cases describe the **real** server. It
checks `get_me` — the one method no case exercises — and prints the wire shape
of the first update once.

## Running conformance

```bash
python -m venv .venv && .venv/bin/pip install -e . && .venv/bin/python -m unittest conformance.test_conformance -v
```

It reads the **same** cases as the other two SDKs, from `../conformance/cases`.

`test_runner_detects_a_mismatch` keeps the runner honest: it takes a passing
case, makes one expectation impossible, and requires the runner to notice. A
runner that has never failed a case is not a tested runner.

- Contract: [`../docs/00-spec.md`](../docs/00-spec.md)
- Invariant vs idiomatic: [`../docs/01-organization.md`](../docs/01-organization.md) §3

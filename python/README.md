# `chasky-bot` — Python SDK

**Delivery 3. Empty: no code yet.**

It arrives last, with the contract already shaken out by two implementations —
which makes it the cheapest of the three, not the least important.

**Do not transliterate the TypeScript SDK.** Use `asyncio`, `snake_case`,
exceptions, and decorators (`@bot.on_text`). A Python SDK that reads like
TypeScript is a bad Python SDK — see §3 of
[`../docs/01-organizacion.md`](../docs/01-organizacion.md).

Two entrypoints in one distribution: `chasky_botsmith` for the runtime and
`chasky_botsmith.management` for management. Shared internals go in `_core/`,
private by convention.

- Contract: [`../docs/00-spec.md`](../docs/00-spec.md) *(in Spanish for now)*

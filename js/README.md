# `@chasky/botsmith` — TypeScript SDK

**Delivery 1. The conformance runner is written; the SDK is not.**

Written in TypeScript, publishing compiled JS plus `.d.ts`. The types are **part
of the public contract**, not documentation: half the traps this SDK exists to
absorb are shape traps.

One package ships from here, with two entrypoints: `@chasky/botsmith` (runtime,
bot token) and `@chasky/botsmith/management` (human session + `X-Secret`).

They share an artifact, not a design: separate constructors, separate error types,
and the runtime never imports from the management subpath. See requirements R-A
through R-D in §6 of the contract. Whatever little they do share lives in `core/`,
which is **internal and never published**.

## Running conformance

The runner lives in [`conformance/`](conformance/) and reads the shared cases from
[`../conformance/cases/`](../conformance/cases/).

```bash
npm install
npm run conformance -- --factory ./fixtures/naive-bot.ts
```

That fixture is a deliberately naive bot, and **every case is expected to fail
against it** — that is how the runner is proven to check anything at all. Once the
SDK exports its adapter, drop the flag:

```bash
npm run conformance
```

Add `--only g7` to run a subset.

## What the SDK has to expose

The runner is written against [`conformance/adapter.ts`](conformance/adapter.ts)
and nothing else. The SDK provides `src/conformance-adapter.ts` exporting a
`BotFactory`. Keeping that interface thin is deliberate: anything richer would let
a case assert something idiomatic, and cases verify observable behaviour only.

- Contract: [`../docs/00-spec.md`](../docs/00-spec.md)
- What must be identical across the three SDKs and what must not:
  [`../docs/01-organization.md`](../docs/01-organization.md) §3

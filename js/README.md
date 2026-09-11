# `@chasky/botsmith-sdk` — TypeScript SDK

**Delivery 1. Runtime implemented — 21/21 conformance, and run against a live
server.**

Written in TypeScript, publishing compiled JS plus `.d.ts`. The types are **part
of the public contract**, not documentation: half the traps this SDK exists to
absorb are shape traps.

One package ships from here: `@chasky/botsmith-sdk`, the bot runtime, which needs
only a bot token. Administration — a developer key, `sk_...` — is a separate
package, [`@chasky/botsmith-sdk-admin`](admin/README.md), published from
[`admin/`](admin/) (D14 in §12 of the contract).

They share no code: separate constructors, separate error types, and neither
imports from the other. See requirements R-A through R-D in §6 of the contract.

## Running conformance

The runner lives in [`conformance/`](conformance/) and reads the shared cases from
[`../conformance/cases/`](../conformance/cases/).

```bash
npm install
npm run conformance -- --factory ./fixtures/naive-bot.ts
```

That fixture is a deliberately naive bot. Cases fail against it **for their own
reason** — and a couple pass, because the naive bot does not violate every
guarantee. A mixed result is the point: a suite that rejects everything proves as
little as one that accepts everything. See "Validating a runner" in
[`../conformance/README.md`](../conformance/README.md).

Once the SDK exports its adapter, drop the flag:

```bash
npm run conformance
```

Add `--only g7` to run a subset.

The management half has its own fixture, which makes the one mistake `m1` exists
to catch — sending `null` for an unset optional instead of omitting it:

```bash
npm run conformance -- --management-factory ./fixtures/broken-management.ts --only m
```

`m1` must fail against it. If it passes, the runner is not checking bodies.

## What the SDK has to expose

The runner is written against [`conformance/adapter.ts`](conformance/adapter.ts)
and nothing else. The SDK provides `src/conformance-adapter.ts` exporting a
`BotFactory`. Keeping that interface thin is deliberate: anything richer would let
a case assert something idiomatic, and cases verify observable behaviour only.

- Contract: [`../docs/00-spec.md`](../docs/00-spec.md)
- What must be identical across the three SDKs and what must not:
  [`../docs/01-organization.md`](../docs/01-organization.md) §3

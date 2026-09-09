# `@chasky/bot` — TypeScript SDK

**Delivery 1. Empty: no code yet.**

Written in TypeScript, publishing compiled JS plus `.d.ts`. The types are **part
of the public contract**, not documentation: half the traps this SDK exists to
absorb are shape traps.

One package ships from here, with two entrypoints: `@chasky/botsmith` (runtime,
bot token) and `@chasky/botsmith/management` (human session + `X-Secret`).

They share an artifact, not a design: separate constructors, separate error types,
and the runtime never imports from the management subpath. See requirements R-A
through R-D in §6 of the contract. Whatever little they do share lives in `core/`,
which is **internal and never published**.

- Contract: [`../docs/00-spec.md`](../docs/00-spec.md) *(in Spanish for now)*
- What must be identical across the three SDKs and what must not:
  [`../docs/01-organizacion.md`](../docs/01-organizacion.md) §3
- No code until D5, D7, D8, D10 and D11 in §12 of the contract are closed.

# `@chasky/bot` — TypeScript SDK

**Delivery 1. Empty: no code yet.**

Written in TypeScript, publishing compiled JS plus `.d.ts`. The types are **part
of the public contract**, not documentation: half the traps this SDK exists to
absorb are shape traps.

Two packages ship from here — `@chasky/bot` (runtime, bot token) and
a management package (human session + `X-Secret`; its name is under review — see
D13). They are separate on
purpose; see §6 of the contract. Whatever little they share lives in `core/`,
which is **internal and never published**.

- Contract: [`../docs/00-spec.md`](../docs/00-spec.md) *(in Spanish for now)*
- What must be identical across the three SDKs and what must not:
  [`../docs/01-organizacion.md`](../docs/01-organizacion.md) §3
- No code until D5, D7, D8, D10 and D11 in §12 of the contract are closed.

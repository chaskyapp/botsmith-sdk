# `@chasky/botsmith-admin`

**NOT FOR BOT AUTHORS.** If you are writing a bot, the package you want is
[`@chasky/botsmith`](../README.md) next door.

Every route this client calls sits behind Chasky's global API secret gate, so it
needs `X-Secret` — **the platform's own secret**, which no third party has or
should have. The runtime's routes are marked public precisely so a bot token is
the only credential an external author ever needs.

This exists for Chasky's own server-side callers: the portal's BFF and internal
tooling. It is a separate package, with a separate name, so that installing it
is a decision rather than an accident.

## Credentials

| | |
|---|---|
| `X-Secret` | the platform API secret. **Never in a browser.** Server-side only. |
| `Authorization: Bearer` | a human session token. Or a cookie — the server takes one or the other, never both. |

A leaked bot token lets someone post as that one bot: bad, bounded, closed by
rotating it. A leaked platform secret opens every non-public route on the API.
They are not the same incident, which is the whole reason these are two
packages.

## Use

```ts
import { AdminClient } from "@chasky/botsmith-admin";

const admin = new AdminClient({ baseUrl, apiSecret, bearerToken });
const { enabled } = await admin.capability();
```

Errors are `AdminError`, deliberately **not** the runtime's error type: a `409`
here means `STALE_STATE` — re-read and retry — while a `409` on the runtime
means another instance evicted you and the bot must stop. Same number, opposite
instruction, so the two must not share a class.

- Contract: [`../../docs/00-spec.md`](../../docs/00-spec.md) §6
- Conformance cases: the four `m*` in [`../../conformance/cases/`](../../conformance/cases/)

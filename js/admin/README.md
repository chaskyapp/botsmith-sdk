# `@chasky/botsmith-admin`

**NOT FOR BOT AUTHORS.** If you are writing a bot, the package you want is
[`@chasky/botsmith`](../README.md) next door.

This client carries a credential that ADMINISTERS bots: whoever holds it can
create them, rotate their tokens and point their webhooks at another server. The
runtime package needs only a bot token and can do none of that. Separate package,
separate name, so installing this one is a decision rather than an accident.

It takes **exactly one** credential, never both:

| Credential | Who uses it |
|---|---|
| `developerKey` (`sk_...`) | a developer administering their own bots from their own code |
| `bearerToken` | a human session — how the portal's own backend calls this |

Passing both throws at construction. The server rejects a request carrying two
credentials rather than picking one, because picking by precedence hides a
misconfiguration; this mirrors that rule where the mistake was made.

Until developer keys existed, every route here sat behind Chasky's global API
secret gate, so calling one needed `X-Secret` — the platform's own secret, which
no third party had or should have. That is exactly why a third party could not
administer their own bots, and why the keys exist.

## Credentials

| | |
|---|---|
| `X-Chasky-Dev-Secret` | a developer key, `sk_...`. **Never in a browser.** Server-side only. |
| `Authorization: Bearer` | a human session token. Or a cookie — the server takes one or the other, never both. |

A leaked bot token lets someone post as that one bot: bad, bounded, closed by
rotating it. A leaked developer key administers every bot you own.
They are not the same incident, which is the whole reason these are two
packages.

## Use

```ts
import { AdminClient } from "@chasky/botsmith-admin";

const admin = new AdminClient({ baseUrl, developerKey: asDeveloperKey(process.env.CHASKY_DEV_KEY) });
const { enabled } = await admin.capability();
```

Errors are `AdminError`, deliberately **not** the runtime's error type: a `409`
here means `STALE_STATE` — re-read and retry — while a `409` on the runtime
means another instance evicted you and the bot must stop. Same number, opposite
instruction, so the two must not share a class.

- Contract: [`../../docs/00-spec.md`](../../docs/00-spec.md) §6
- Conformance cases: the four `m*` in [`../../conformance/cases/`](../../conformance/cases/)

# `chasky-botsmith-admin`

**NOT FOR BOT AUTHORS.** If you are writing a bot, the package you want is
[`chasky-botsmith`](../README.md) next door.

This client carries a credential that ADMINISTERS bots: whoever holds it can
create them, rotate their tokens and point their webhooks at another server. The
runtime distribution needs only a bot token and can do none of that. Separate
distribution, separate name, so installing this one is a decision rather than an
accident.

It takes **exactly one** credential, never both:

| Credential | Who uses it |
|---|---|
| `developer_key` (`sk_...`) | a developer administering their own bots from their own code |
| `bearer_token` | a human session — how the portal's own backend calls this |

Passing both raises at construction. The server rejects a request carrying two
credentials rather than picking one, because picking by precedence hides a
misconfiguration; this mirrors that rule where the mistake was made.

Until developer keys existed, every route here sat behind Chasky's global API
secret gate, so calling one needed `X-Secret` — the platform's own secret, which
no third party had or should have. That is exactly why a third party could not
administer their own bots, and why the keys exist.

```python
from chasky_botsmith_admin import AdminClient

admin = AdminClient(base_url=..., developer_key=as_developer_key(os.environ["CHASKY_DEV_KEY"]))
capability = await admin.capability()
```

Errors are `AdminError`, deliberately **not** the runtime's type: a `409` here
means `STALE_STATE` — re-read and retry — while a `409` on the runtime means
another instance evicted you and the bot must stop. Same number, opposite
instruction.

## Installing both for development

```bash
python -m venv .venv && .venv/bin/pip install -e . -e admin
```

from the `python/` directory. The conformance runner needs both.

# `chasky-botsmith-admin`

**NOT FOR BOT AUTHORS.** If you are writing a bot, the package you want is
[`chasky-botsmith`](../README.md) next door.

Every route this client calls sits behind Chasky's global API secret gate, so it
needs `X-Secret` — **the platform's own secret**, which no third party has or
should have. The runtime's routes are marked public precisely so a bot token is
the only credential an external author ever needs.

This exists for Chasky's own server-side callers: the portal's BFF and internal
tooling. Separate distribution, separate name, so installing it is a decision
rather than an accident.

```python
from chasky_botsmith_admin import AdminClient

admin = AdminClient(base_url=..., api_secret=..., bearer_token=...)
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

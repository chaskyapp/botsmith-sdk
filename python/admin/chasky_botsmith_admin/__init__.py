"""Client for BotSmith, the Chasky bot administration surface at /bot-management.

NOT FOR BOT AUTHORS. The credential here administers bots — it can create them,
rotate their tokens and point their webhooks somewhere else — while the
``chasky_botsmith`` distribution next door needs only a bot token and can do
none of that. Separate distribution, separate name, so installing this one is a
decision rather than an accident.

The credential is EXACTLY ONE of two, never both:

- ``developer_key`` (``sk_...``) — a developer administering their own bots from
  their own code, issued from BotSmith and revocable on its own.
- ``bearer_token`` — a human session, which is how the portal's own backend
  calls this surface.

Until the developer-key delta these routes sat behind Chasky's global API secret
gate, so calling one needed X-Secret: the platform's own secret, which no third
party has or should have. That is exactly why a third party could not administer
their own bots, and why the keys exist.

A SEPARATE module from the runtime on purpose, and the separation is requirement
R-B in §6 of the contract rather than a stylistic choice. The two surfaces
authenticate differently — a bot token in the path versus a developer key or a
human session in a header — use incompatible envelopes, and disagree about a 409
means::

    runtime     409 CONFLICT_POLLING  another instance evicted you  -> STOP
    management  409 STALE_STATE       your revision is stale        -> RE-READ AND RETRY

Same number, opposite instruction. With one shared error type, an
``if error.code == 409: retry()`` written for management and reused in the
runtime puts two bots into an eviction war.

The server's decoder is strict: an unknown field, a duplicate field, or a null —
even where the field is optional — is 400 INVALID_INPUT. Every request body here
is therefore built field by field, adding only what is set. That matters more in
Python than anywhere else: ``json.dumps`` writes ``None`` as ``null``, so a
dataclass serialised wholesale would be rejected for a call the caller wrote
correctly.
"""

from .client import CommandParams, AdminClient, PageParams
from .facade import CreateBotParams, CreateBotResult
from .errors import AdminCode, AdminError, AdminTransportError, DeveloperKey, as_developer_key
from .types import (
    BotView,
    Capability,
    CommandKind,
    CommandResult,
    DeveloperKeyReveal,
    DeveloperKeyView,
    DialogueEvent,
    Draft,
    GrantView,
    OperationReceipt,
    Page,
    SecretReveal,
)

__all__ = [
    "BotView",
    "Capability",
    "CommandKind",
    "CommandParams",
    "CreateBotParams",
    "CreateBotResult",
    "CommandResult",
    "DeveloperKeyReveal",
    "DeveloperKeyView",
    "DialogueEvent",
    "Draft",
    "GrantView",
    "AdminClient",
    "AdminCode",
    "AdminError",
    "AdminTransportError",
    "DeveloperKey",
    "as_developer_key",
    "OperationReceipt",
    "Page",
    "PageParams",
    "SecretReveal",
]

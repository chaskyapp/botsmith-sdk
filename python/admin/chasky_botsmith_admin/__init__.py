"""Client for BotSmith, the Chasky bot administration surface at /bot-management.

NOT FOR BOT AUTHORS. Every route here sits behind Chasky's global API secret
gate, so calling one needs X-Secret — the platform's own secret, which no third
party has or should have. The ``chasky_botsmith`` distribution next door is the
one a bot author installs, and the runtime's routes are marked public exactly so
a token is the only credential they need.

This exists for Chasky's own server-side callers: the portal's BFF and internal
tooling. Separate distribution, separate name, so installing it is a decision
rather than an accident.

A SEPARATE module from the runtime on purpose, and the separation is requirement
R-B in §6 of the contract rather than a stylistic choice. The two surfaces
authenticate differently — a bot token in the path versus a human session plus
the platform secret — use incompatible envelopes, and disagree about what a 409
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
from .errors import AdminCode, AdminError, AdminTransportError, PlatformSecret, as_platform_secret
from .types import (
    BotView,
    Capability,
    CommandKind,
    CommandResult,
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
    "CommandResult",
    "DialogueEvent",
    "Draft",
    "GrantView",
    "AdminClient",
    "AdminCode",
    "AdminError",
    "AdminTransportError",
    "PlatformSecret",
    "as_platform_secret",
    "OperationReceipt",
    "Page",
    "PageParams",
    "SecretReveal",
]

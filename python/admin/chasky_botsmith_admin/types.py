"""Management view types, mirroring the server's allowlisted projections."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Generic, Literal, TypeVar

T = TypeVar("T")

CommandKind = Literal[
    "/newbot", "/mybots", "/help", "/cancel", "value", "select", "name",
    "description", "issue", "rotate", "revoke", "archive", "unarchive",
    "publish", "unpublish", "webhook", "unwebhook", "/keys", "newkey", "revokekey",
    "confirm",
]

DialogueStep = Literal[
    "menu", "new_name", "new_username", "confirm_create", "select_bot",
    "bot_menu", "edit_name", "edit_description", "webhook_url", "keys", "key_label",
    "key_preview", "confirm_change",
]

OperationState = Literal["pending", "completed", "rejected"]


@dataclass(frozen=True, slots=True)
class BotView:
    id: str
    name: str
    username: str
    description: str
    state: str
    #: What the dialogue compare-and-sets when publishing, as ``state`` is when
    #: archiving.
    visibility: str
    #: The destination. The SECRET appears here in no view.
    webhook_url: str
    webhook_state: str
    credential_state: str
    credential_version: int
    metadata_version: int


@dataclass(frozen=True, slots=True)
class Capability:
    enabled: bool
    can_manage_administrators: bool
    #: Lets a client warn BEFORE the user spends four steps typing a name and
    #: username only to be refused at confirm. The cap is still the backend's.
    max_bots: int
    #: Announces the gate so a client does not offer a button that always fails.
    webhook_enabled: bool
    #: Announces whether the server has developer keys wired, for the same reason.
    developer_keys_enabled: bool


@dataclass(frozen=True, slots=True)
class Page(Generic[T]):
    items: list[T]
    has_more: bool
    next_cursor: str | None = None


@dataclass(frozen=True, slots=True)
class Draft:
    name: str | None = None
    username: str | None = None
    description: str | None = None
    bot_id: str | None = None
    action: str | None = None
    expected_metadata_version: int | None = None
    expected_credential_version: int | None = None
    key_label: str | None = None
    key_preview: str | None = None


@dataclass(frozen=True, slots=True)
class OperationReceipt:
    operation_id: str
    state: OperationState
    bot_id: str | None = None
    credential_version: int | None = None


@dataclass(frozen=True, slots=True)
class DialogueEvent:
    revision: int
    step: DialogueStep
    draft: Draft
    receipt: OperationReceipt
    #: A CODE, not rendered text. The server is explicit that codes are the
    #: durable transcript format, so this SDK promises no readable message.
    message_code: str
    created_at: str


@dataclass(frozen=True, slots=True)
class SecretReveal:
    """Carries a live token.

    The server marks it response-only — its own ``String()`` prints
    ``[credential redacted]`` — so it is returned to the caller and retained
    nowhere else. ``__repr__`` is overridden so it cannot land in a log by
    accident.
    """

    bot_id: str
    token: str
    version: int

    def __repr__(self) -> str:
        return "SecretReveal(<credential redacted>)"

    def __str__(self) -> str:
        return "[credential redacted]"


@dataclass(frozen=True, slots=True)
class DeveloperKeyReveal:
    """Carries a live developer key.

    It exists only in the response to the confirm that issued it — the server
    keeps just its hash — so it is returned to the caller once and retained
    nowhere else. ``__repr__`` is overridden so it cannot land in a log.
    """

    value: str
    owner_id: str
    created_at: str

    def __repr__(self) -> str:
        return "DeveloperKeyReveal(<developer key redacted>)"


@dataclass(frozen=True, slots=True)
class DeveloperKeyView:
    """What a listing shows about a key: its publishable preview (sk_ + 6 hex),
    never the hash or the value. Revoked keys are listed on purpose."""

    preview: str
    created_at: str
    label: str | None = None
    revoked_at: str | None = None


@dataclass(frozen=True, slots=True)
class CommandResult:
    event: DialogueEvent
    secret: SecretReveal | None = None
    #: Only on the confirm that issued a key: the one copy that will ever exist.
    developer_key: DeveloperKeyReveal | None = None
    recovery_required: bool = False

    def __repr__(self) -> str:
        return "CommandResult(<management command result redacted>)"


@dataclass(frozen=True, slots=True)
class GrantView:
    target_id: str
    revision: int
    enabled: bool


def draft_from_wire(raw: dict[str, Any]) -> Draft:
    return Draft(
        name=raw.get("name"),
        username=raw.get("username"),
        description=raw.get("description"),
        bot_id=raw.get("botID"),
        action=raw.get("action"),
        expected_metadata_version=raw.get("expectedMetadataVersion"),
        expected_credential_version=raw.get("expectedCredentialVersion"),
        key_label=raw.get("keyLabel"),
        key_preview=raw.get("keyPreview"),
    )


def event_from_wire(raw: dict[str, Any]) -> DialogueEvent:
    receipt = raw.get("receipt") or {}
    return DialogueEvent(
        revision=raw.get("revision", 0),
        step=raw.get("step", "menu"),
        draft=draft_from_wire(raw.get("draft") or {}),
        receipt=OperationReceipt(
            operation_id=receipt.get("operationID", ""),
            state=receipt.get("state", "pending"),
            bot_id=receipt.get("botID"),
            credential_version=receipt.get("credentialVersion"),
        ),
        message_code=raw.get("messageCode", ""),
        created_at=raw.get("createdAt", ""),
    )


def bot_from_wire(raw: dict[str, Any]) -> BotView:
    return BotView(
        id=raw.get("id", ""),
        name=raw.get("name", ""),
        username=raw.get("username", ""),
        description=raw.get("description", ""),
        state=raw.get("state", ""),
        visibility=raw.get("visibility", ""),
        webhook_url=raw.get("webhookUrl", ""),
        webhook_state=raw.get("webhookState", ""),
        credential_state=raw.get("credentialState", ""),
        credential_version=raw.get("credentialVersion", 0),
        metadata_version=raw.get("metadataVersion", 0),
    )

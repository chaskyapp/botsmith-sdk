"""Domain types. See §7.1 of ../../docs/00-spec.md."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Literal

# Identifiers are strings and this package never converts one. See §9 of the
# contract: a real chat id carries the "bot:" prefix twice, so anything that
# "understands" the format well enough to take it apart breaks on a live
# server. An id is an opaque label.
ChatID = str
UserID = str
MessageID = str

# The one numeric identifier: an int counter, one per bot. Python ints are
# arbitrary precision, so the 2^53 caveat the JavaScript SDK carries does not
# apply here. Gaps in the sequence are valid and are not loss.
UpdateID = int

ChatAction = Literal["typing"]


@dataclass(frozen=True, slots=True)
class WebhookInfo:
    """What ``get_webhook_info`` reports.

    An empty ``state`` means the bot has no destination registered and is still
    polling; ``active`` and ``suspended`` are the webhook states.
    ``has_secret_token`` answers "is one configured", never "which one" — the
    server does not reveal it and neither does this.
    """

    url: str
    has_secret_token: bool
    pending_update_count: int
    #: The LAST RUN of failures, not all time: a successful delivery clears
    #: them. An error from three days ago beside a working webhook explains
    #: nothing.
    last_error_at: datetime | None = None
    last_error_message: str | None = None
    #: Empty while polling.
    state: str | None = None


def webhook_info_from_wire(raw: dict[str, Any]) -> WebhookInfo:
    last_error = raw.get("last_error_date")
    return WebhookInfo(
        url=raw.get("url", ""),
        has_secret_token=raw.get("has_secret_token", False),
        pending_update_count=raw.get("pending_update_count", 0),
        last_error_at=datetime.fromtimestamp(last_error, tz=timezone.utc) if last_error else None,
        last_error_message=raw.get("last_error_message") or None,
        state=raw.get("state") or None,
    )


@dataclass(frozen=True, slots=True)
class User:
    id: UserID
    name: str


@dataclass(frozen=True, slots=True)
class Chat:
    id: ChatID
    type: str


@dataclass(frozen=True, slots=True)
class BotMessage:
    message_id: MessageID
    from_user: User
    chat: Chat
    #: The wire carries seconds since the epoch; this is timezone-aware UTC.
    date: datetime
    text: str


@dataclass(frozen=True, slots=True)
class Update:
    update_id: UpdateID
    message: BotMessage | None = None


@dataclass(frozen=True, slots=True)
class BotIdentity:
    id: UserID
    is_bot: bool
    username: str
    #: Mapped from the server's ``first_name``, which is Telegram-shaped while
    #: the rest of the contract is Chasky-shaped. Server request S2 in §13.
    display_name: str


def message_from_wire(raw: dict[str, Any]) -> BotMessage:
    sender = raw.get("from") or {}
    return BotMessage(
        message_id=raw.get("message_id", ""),
        from_user=User(id=sender.get("id", ""), name=sender.get("name", "")),
        chat=Chat(id=raw["chat"]["id"], type=raw["chat"].get("type", "")),
        date=datetime.fromtimestamp(raw.get("date", 0), tz=timezone.utc),
        text=raw.get("text", ""),
    )


def update_from_wire(raw: dict[str, Any]) -> Update:
    message = raw.get("message")
    return Update(
        update_id=raw["update_id"],
        message=message_from_wire(message) if message else None,
    )

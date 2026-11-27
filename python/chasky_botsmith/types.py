"""Domain types. See §7.1 of ../../docs/00-spec.md."""

from __future__ import annotations

from dataclasses import dataclass, field
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
    #: Sent in groups. None in a 1:1, where the sender is always a person.
    is_bot: bool | None = None


@dataclass(frozen=True, slots=True)
class Chat:
    id: ChatID
    #: "private" or "group" today. A plain str on purpose: a value this version
    #: does not know must still decode (G10).
    type: str
    #: Groups only.
    title: str | None = None


@dataclass(frozen=True, slots=True)
class Mention:
    """A person the message mentions. Bots are never listed."""

    #: As received; an id is an opaque label.
    user_id: UserID
    name: str


@dataclass(frozen=True, slots=True)
class ReplyTo:
    """The message a reply answers: just what the server embeds."""

    message_id: MessageID
    from_user: User
    text: str


@dataclass(frozen=True, slots=True)
class BotMessage:
    message_id: MessageID
    from_user: User
    chat: Chat
    #: The wire carries seconds since the epoch; this is timezone-aware UTC.
    date: datetime
    text: str
    reply_to_message: ReplyTo | None = None
    #: The people mentioned (G12). Empty when none.
    mentions: tuple[Mention, ...] = ()
    #: True only when the message mentions THIS bot.
    mentioned: bool = False


@dataclass(frozen=True, slots=True)
class ChatMemberState:
    """The bot's standing in a chat. ``status`` is free text, like Chat.type."""

    status: str
    read_mode: str | None = None
    history_mode: str | None = None


@dataclass(frozen=True, slots=True)
class ChatMemberUpdated:
    """The bot was added to a chat, had its modes changed, or left (G10)."""

    chat: Chat
    from_user: User
    date: datetime
    old_state: ChatMemberState
    new_state: ChatMemberState


@dataclass(frozen=True, slots=True)
class Update:
    update_id: UpdateID
    message: BotMessage | None = None
    my_chat_member: ChatMemberUpdated | None = None
    #: The update exactly as received, so a kind this version has no field for
    #: is still readable (G10).
    raw: dict[str, Any] = field(default_factory=dict, repr=False, compare=False)


@dataclass(frozen=True, slots=True)
class BotIdentity:
    id: UserID
    is_bot: bool
    username: str
    #: Mapped from the server's ``first_name``, which is Telegram-shaped while
    #: the rest of the contract is Chasky-shaped. Server request S2 in §13.
    display_name: str


def _user(raw: dict[str, Any] | None) -> User:
    raw = raw or {}
    is_bot = raw.get("is_bot")
    return User(
        id=raw.get("id", ""),
        name=raw.get("name", ""),
        is_bot=is_bot if isinstance(is_bot, bool) else None,
    )


def _chat(raw: dict[str, Any]) -> Chat:
    return Chat(id=raw["id"], type=raw.get("type", ""), title=raw.get("title"))


def _state(raw: dict[str, Any] | None) -> ChatMemberState:
    raw = raw or {}
    return ChatMemberState(
        status=raw.get("status", ""),
        read_mode=raw.get("read_mode") or None,
        history_mode=raw.get("history_mode") or None,
    )


def _date(raw: dict[str, Any]) -> datetime:
    return datetime.fromtimestamp(raw.get("date", 0), tz=timezone.utc)


def message_from_wire(raw: dict[str, Any]) -> BotMessage:
    reply = raw.get("reply_to_message")
    return BotMessage(
        message_id=raw.get("message_id", ""),
        from_user=_user(raw.get("from")),
        chat=_chat(raw["chat"]),
        date=_date(raw),
        text=raw.get("text", ""),
        mentions=tuple(
            Mention(user_id=m.get("user_id", ""), name=m.get("name") or "")
            for m in raw.get("mentions") or []
        ),
        mentioned=raw.get("mentioned") is True,
        reply_to_message=(
            ReplyTo(
                message_id=reply.get("message_id", ""),
                from_user=_user(reply.get("from")),
                text=reply.get("text", ""),
            )
            if reply
            else None
        ),
    )


def update_from_wire(raw: dict[str, Any]) -> Update:
    message = raw.get("message")
    member = raw.get("my_chat_member")
    return Update(
        update_id=raw["update_id"],
        message=message_from_wire(message) if message else None,
        my_chat_member=(
            ChatMemberUpdated(
                chat=_chat(member["chat"]),
                from_user=_user(member.get("from")),
                date=_date(member),
                old_state=_state(member.get("old_state")),
                new_state=_state(member.get("new_state")),
            )
            if member
            else None
        ),
        raw=raw,
    )

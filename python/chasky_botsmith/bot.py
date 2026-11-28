"""The runtime: handlers, dispatch, and a managed Idempotency-Key."""

from __future__ import annotations

import asyncio
import re
import uuid
from dataclasses import dataclass, field
from typing import Awaitable, Callable, Mapping

import httpx

from .client import Client
from .errors import UsageError, classify, retry_delay
from .polling import Polling, Transport, TransportDeps, _backoff
from .types import BotMessage, ChatID, MessageID, Update, UserID


@dataclass(slots=True)
class Event:
    """One update delivered to a handler, with the shortcuts to answer it."""

    update: Update
    message: BotMessage
    chat_id: ChatID
    client: Client
    _attempts: int = field(repr=False, default=4)
    _on_error: Callable[[BaseException], None] = field(repr=False, default=lambda _e: None)

    async def reply(
        self,
        text: str,
        *,
        reply_to_message_id: MessageID | None = None,
        mentions: Mapping[str, UserID] | None = None,
    ) -> BotMessage:
        """Send to this update's chat with a managed Idempotency-Key."""
        return await _send_with_retry(
            self.client,
            # G9: the chat id goes back exactly as it arrived. Never parsed,
            # never rebuilt — a real chat id carries "bot:" twice, and anything
            # that takes it apart breaks against a live server.
            chat_id=self.chat_id,
            text=text,
            reply_to_message_id=reply_to_message_id,
            mentions=mentions,
            attempts=self._attempts,
            on_error=self._on_error,
        )

    async def typing(self) -> None:
        """Explicit on purpose: the runtime never sends a chat action itself.

        Whether the indicator helps depends on how long the bot takes to
        answer, which is the author's call and not the SDK's.
        """
        await self.client.send_chat_action(chat_id=self.chat_id)


Handler = Callable[[Event], Awaitable[None]]

#: Sees every update, including ones with no message (G10).
UpdateHandler = Callable[[Update], Awaitable[None]]


class Bot:
    def __init__(
        self,
        token: str,
        *,
        base_url: str | None = None,
        transport: Transport | None = None,
        send_attempts: int = 4,
        http: httpx.AsyncClient | None = None,
        on_warning: Callable[[str], None] | None = None,
        allow_insecure_transport: bool = False,
    ) -> None:
        self.client = Client(
            token,
            base_url=base_url,
            http=http,
            on_warning=on_warning,
            allow_insecure_transport=allow_insecure_transport,
        )
        self._transport = transport or Polling()
        self._attempts = send_attempts
        self._commands: dict[str, Handler] = {}
        self._handlers: list[Handler] = []
        self._attachment_handlers: list[Handler] = []
        self._update_handlers: list[UpdateHandler] = []
        self._error_listeners: list[Callable[[BaseException], None]] = []
        self._running = False
        #: Learned from getMe the first time a suffixed command needs it (G13).
        self._username: str | None = None

    def command(self, name: str) -> Callable[[Handler], Handler]:
        """Register a handler for ``/name``, as a decorator."""

        def decorate(handler: Handler) -> Handler:
            self._commands[name.lstrip("/")] = handler
            return handler

        return decorate

    def on_text(self, handler: Handler) -> Handler:
        """Register a handler for any text that matched no command."""
        self._handlers.append(handler)
        return handler

    def on_attachment(self, handler: Handler) -> Handler:
        """Register a handler for a message that carries attachments (G14).

        It runs instead of the command and text handlers: such a message has an
        empty ``text``, and what was written is ``caption``.
        """
        self._attachment_handlers.append(handler)
        return handler

    def on_update(self, handler: UpdateHandler) -> UpdateHandler:
        """Run for EVERY update, before command and text dispatch (G10).

        That includes updates with no message and kinds this version has no
        field for; ``update.raw`` still carries them.
        """
        self._update_handlers.append(handler)
        return handler

    def on_error(self, listener: Callable[[BaseException], None]) -> Callable[[BaseException], None]:
        self._error_listeners.append(listener)
        return listener

    async def run(self) -> None:
        """Poll until cancelled, or until a terminal failure, which is raised.

        There is no ``on_fatal``: in Python an error that ends the loop is an
        exception, and callers already know how to handle one.
        """
        # G1: one in-flight poll per instance. Two overlapping polls on one bot
        # used to split the updates silently; the server now answers 409, but
        # the SDK should never be the one causing it.
        if self._running:
            raise UsageError("this bot is already running")
        self._running = True
        try:
            await self._transport.run(
                TransportDeps(
                    client=self.client,
                    on_update=self._dispatch,
                    on_error=self._emit_error,
                )
            )
        finally:
            self._running = False

    async def aclose(self) -> None:
        await self.client.aclose()

    async def __aenter__(self) -> "Bot":
        return self

    async def __aexit__(self, *_exc: object) -> None:
        await self.aclose()

    def _emit_error(self, error: BaseException) -> None:
        for listener in self._error_listeners:
            listener(error)

    async def _dispatch(self, update: Update) -> None:
        for update_handler in self._update_handlers:
            await update_handler(update)
        if update.message is None:
            return
        event = Event(
            update=update,
            message=update.message,
            chat_id=update.message.chat.id,
            client=self.client,
            _attempts=self._attempts,
            _on_error=self._emit_error,
        )
        if update.message.attachments:
            # Never the text handler: it would see "" and answer a file as if
            # it were an empty message (G14).
            for attachment_handler in self._attachment_handlers:
                await attachment_handler(event)
            return
        handler = await self._command_handler(update.message.text)
        if handler is not None:
            await handler(event)
            return
        for fallback in self._handlers:
            await fallback(event)

    async def _command_handler(self, text: str) -> Handler | None:
        """The handler for a command addressed to this bot, if any (G13)."""
        name, target = _parse_command(text)
        handler = self._commands.get(name) if name else None
        if handler is None or target is None:
            return handler
        if self._username is None:
            # Asked once, and only when a suffix makes it matter. A failure is
            # not cached: it surfaces like any handler failure and the next
            # suffixed command asks again.
            self._username = (await self.client.get_me()).username
        return handler if _same_username(target, self._username) else None


async def _send_with_retry(
    client: Client,
    *,
    chat_id: ChatID,
    text: str,
    reply_to_message_id: MessageID | None,
    mentions: Mapping[str, UserID] | None,
    attempts: int,
    on_error: Callable[[BaseException], None],
) -> BotMessage:
    """G4: one key per logical message, the SAME key on every retry of THAT one.

    The key is generated once, outside the loop. A fresh key per attempt turns
    a retry into a second message — the user sees the bot answer twice — and
    reusing one key across different messages makes the server discard the
    second SILENTLY, which is worse because it looks like it worked.
    """
    key = str(uuid.uuid4())
    last_error: BaseException | None = None
    for attempt in range(1, attempts + 1):
        try:
            return await client.send_message(
                chat_id=chat_id,
                text=text,
                reply_to_message_id=reply_to_message_id,
                mentions=mentions,
                idempotency_key=key,
            )
        except asyncio.CancelledError:
            raise
        except Exception as error:  # noqa: BLE001 - classify decides
            last_error = error
            if classify(error, "call") != "transient":
                raise
            if attempt == attempts:
                break
            on_error(error)
            # A 429 says how long to wait (G11); the key above stays the same.
            await asyncio.sleep(retry_delay(error, _backoff(attempt, 0.25, 4.0)))
    assert last_error is not None
    raise last_error


#: The server's rule (isCommandFor): the command word runs from the slash to
#: the first whitespace, with no trimming before the slash.
_COMMAND_WORD = re.compile(r"/([^ \t\r\n]*)")


def _parse_command(text: str) -> tuple[str, str | None]:
    """Split ``/name@target args`` into ``(name, target)``.

    ``target`` is None when there is no ``@``, and ``""`` for a bare ``/name@``,
    which addresses no bot and so is never this one. A name of ``""`` means the
    text is not a command at all.
    """
    match = _COMMAND_WORD.match(text)
    if match is None:
        return "", None
    name, at, target = match.group(1).partition("@")
    return name, (target if at else None)


def _same_username(target: str, username: str) -> bool:
    """Case-insensitive, with a leading ``@`` ignored on the bot's side."""
    return target != "" and target.lower() == username.removeprefix("@").lower()

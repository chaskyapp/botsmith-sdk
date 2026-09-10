"""Client SDK for the Chasky Bot API.

This is a port of the contract in ../docs/00-spec.md, not of the TypeScript SDK.
The guarantees (G1-G9) and delegations (L1-L5) are identical and the shared
conformance suite verifies that; the shape is Python's — asyncio, exceptions,
decorators, snake_case.

Basic use::

    bot = Bot(token=os.environ["CHASKY_BOT_TOKEN"])

    @bot.command("start")
    async def start(event: Event) -> None:
        await event.reply("Hello.")

    @bot.on_text
    async def echo(event: Event) -> None:
        await event.reply(f"You said: {event.message.text}")

    await bot.run()

Three things the contract insists on, because they are what a hand-written
client gets wrong:

* Exactly one process may poll a bot. Starting a second one evicts the first,
  which then receives 409 CONFLICT_POLLING and stops.
* The offset always advances, even past an update whose handler raised. It is a
  read cursor, not a business acknowledgement.
* The token travels in the URL path, so it leaks into transport errors. Every
  exception this package raises has been redacted first.
"""

from .bot import Bot, Event, Handler
from .client import (
    DEFAULT_BASE_URL,
    MAX_LIMIT,
    MAX_TIMEOUT_SECONDS,
    Client,
)
from .errors import APIError, ChaskyError, TransportError, UsageError
from .polling import Polling, Transport
from .types import (
    BotIdentity,
    BotMessage,
    Chat,
    ChatAction,
    Update,
    User,
    WebhookInfo,
)

__all__ = [
    "APIError",
    "Bot",
    "BotIdentity",
    "BotMessage",
    "ChaskyError",
    "Chat",
    "ChatAction",
    "Client",
    "DEFAULT_BASE_URL",
    "Event",
    "Handler",
    "MAX_LIMIT",
    "MAX_TIMEOUT_SECONDS",
    "Polling",
    "Transport",
    "TransportError",
    "Update",
    "UsageError",
    "User",
    "WebhookInfo",
]

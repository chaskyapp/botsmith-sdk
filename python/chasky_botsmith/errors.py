"""Exception hierarchy and the classification that drives retries (§10)."""

from __future__ import annotations

from typing import Literal


class ChaskyError(Exception):
    """Base for everything this package raises."""


class APIError(ChaskyError):
    """A failure the server described in its envelope."""

    def __init__(self, code: int, description: str, method: str) -> None:
        super().__init__(f"{method} failed: {code} {description}")
        #: The flow control. Never branch on ``description``: the server
        #: declares it readable and stable, but not enumerated.
        self.code = code
        self.description = description
        self.method = method


class TransportError(ChaskyError):
    """The request never produced an envelope: network, cancellation, bad JSON.

    The message is already redacted. ``__cause__`` still reaches the original,
    so ``isinstance(err.__cause__, asyncio.CancelledError)`` keeps working.
    """


class UsageError(ChaskyError):
    """Raised locally, before spending a request."""


ErrorClass = Literal["terminal", "business", "transient"]
ErrorSource = Literal["poll", "call"]


def classify(error: BaseException, source: ErrorSource) -> ErrorClass:
    """Decide what the SDK does with a failure (§10.2, G7).

    Classification reads the code and *which call produced it*, never the
    description. A 403 while polling means this bot is barred from polling at
    all and is terminal; a 403 from a send means that one chat is not ours and
    the bot lives on. Reading the method is both correct and immune to a
    description the server never promised to keep enumerated.
    """
    if isinstance(error, APIError):
        if error.code >= 500:
            return "transient"
        if source == "poll" and error.code in (401, 403, 409):
            return "terminal"
        if source == "call" and error.code == 401:
            return "terminal"
        return "business"
    if isinstance(error, UsageError):
        return "business"
    return "transient"

"""Management errors, deliberately distinct from the runtime's."""

from __future__ import annotations

from typing import Literal, NewType

#: The platform's own API secret, deliberately not a plain ``str``.
#:
#: A leaked bot token lets someone post as that one bot: bad, bounded, closed by
#: rotating it. This opens every non-public route on the API. They are not the
#: same incident, and a distinct type keeps them from being passed to the same
#: places — a type checker rejects a bare string, and ``as_platform_secret(...)``
#: reads wrong wherever it does not belong.
PlatformSecret = NewType("PlatformSecret", str)


def as_platform_secret(value: str) -> PlatformSecret:
    """Acknowledge a value as the platform secret."""
    if not value:
        raise ValueError("the platform secret must not be empty")
    return PlatformSecret(value)

AdminCode = Literal[
    "INVALID_INPUT",
    "UNAUTHORIZED",
    "FORBIDDEN",
    "NOT_FOUND",
    "STALE_STATE",
    "QUOTA_EXCEEDED",
    "TOO_MANY_ATTEMPTS",
    "UNAVAILABLE",
    "RECOVERY_REQUIRED",
    "UNKNOWN",
]

_STATUS_TO_CODE: dict[int, AdminCode] = {
    400: "INVALID_INPUT",
    401: "UNAUTHORIZED",
    403: "FORBIDDEN",
    404: "NOT_FOUND",
    409: "STALE_STATE",
    422: "QUOTA_EXCEEDED",
    429: "TOO_MANY_ATTEMPTS",
    503: "UNAVAILABLE",
}


class AdminError(Exception):
    def __init__(self, code: AdminCode, status: int, method: str) -> None:
        super().__init__(f"{method} failed: {code}")
        self.code = code
        self.status = status
        self.method = method

    @property
    def retryable(self) -> bool:
        """Whether re-reading the current revision and resending is right.

        STALE_STATE is the point of the dialogue's optimistic concurrency:
        someone advanced it, so read ``dialogue()`` again and resend with the
        revision just seen.
        """
        return self.code in ("STALE_STATE", "UNAVAILABLE")

    @property
    def access_lost(self) -> bool:
        """Whether administration is actually gone.

        QUOTA_EXCEEDED and TOO_MANY_ATTEMPTS are deliberately NOT FORBIDDEN on
        the server. Its own comment explains why: a caller treats 403 as "your
        administration was revoked" and tears the session down, while a quota
        reached is normal and recoverable. Reporting either as lost access lies
        about what happened.
        """
        return self.code in ("UNAUTHORIZED", "FORBIDDEN")


class AdminTransportError(Exception):
    """The request never produced an envelope."""


def code_for(envelope_code: object, status: int) -> AdminCode:
    """Prefer the envelope's code; fall back to the status."""
    if isinstance(envelope_code, str) and envelope_code:
        return envelope_code  # type: ignore[return-value]
    return _STATUS_TO_CODE.get(status, "UNKNOWN")

"""Management errors, deliberately distinct from the runtime's."""

from __future__ import annotations

from typing import Literal

ManagementCode = Literal[
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

_STATUS_TO_CODE: dict[int, ManagementCode] = {
    400: "INVALID_INPUT",
    401: "UNAUTHORIZED",
    403: "FORBIDDEN",
    404: "NOT_FOUND",
    409: "STALE_STATE",
    422: "QUOTA_EXCEEDED",
    429: "TOO_MANY_ATTEMPTS",
    503: "UNAVAILABLE",
}


class ManagementError(Exception):
    def __init__(self, code: ManagementCode, status: int, method: str) -> None:
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


class ManagementTransportError(Exception):
    """The request never produced an envelope."""


def code_for(envelope_code: object, status: int) -> ManagementCode:
    """Prefer the envelope's code; fall back to the status."""
    if isinstance(envelope_code, str) and envelope_code:
        return envelope_code  # type: ignore[return-value]
    return _STATUS_TO_CODE.get(status, "UNKNOWN")

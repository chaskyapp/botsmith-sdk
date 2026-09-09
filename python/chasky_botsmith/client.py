"""The raw client: a 1:1 wrapper over the four methods, with no loop."""

from __future__ import annotations

import ipaddress
from typing import Any, Callable
from urllib.parse import urlparse

import httpx

from .errors import APIError, TransportError, UsageError
from .redact import redact_exception
from .types import (
    BotIdentity,
    BotMessage,
    ChatAction,
    ChatID,
    MessageID,
    Update,
    message_from_wire,
    update_from_wire,
)

#: Server maximums, hardcoded because the server does not publish them yet
#: (request S3 in §13). When it does, these become the fallback.
MAX_LIMIT = 100
MAX_TIMEOUT_SECONDS = 30

DEFAULT_BASE_URL = "https://api.chasky.io/api/v1"


class Client:
    """Safe to share; every method is a single request."""

    def __init__(
        self,
        token: str,
        *,
        base_url: str | None = None,
        http: httpx.AsyncClient | None = None,
        on_warning: Callable[[str], None] | None = None,
        allow_insecure_transport: bool = False,
    ) -> None:
        if not token:
            raise UsageError("a bot token is required")
        self._token = token
        self._base_url = (base_url or DEFAULT_BASE_URL).rstrip("/")
        self._warn = on_warning or (lambda _message: None)
        self._owns_http = http is None
        # Room for the longest poll plus latency. Cancellation is the task's
        # job, not this timeout's.
        self._http = http or httpx.AsyncClient(timeout=MAX_TIMEOUT_SECONDS + 15)

        # D8: warn ONCE, at construction. A warning per poll is noise that ends
        # up filtered out of a grep, which is the same as no warning at all.
        if not allow_insecure_transport and _is_insecure(self._base_url):
            self._warn(
                "base_url uses plaintext http:// to a non-loopback host. The bot token "
                "travels in the URL PATH, so every proxy on the way writes it down. Use "
                "https://, or pass allow_insecure_transport=True to accept this."
            )

    async def __aenter__(self) -> "Client":
        return self

    async def __aexit__(self, *_exc: object) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        if self._owns_http:
            await self._http.aclose()

    async def get_me(self) -> BotIdentity:
        raw = await self._call("getMe", {})
        return BotIdentity(
            id=raw.get("id", ""),
            is_bot=True,
            username=raw.get("username", ""),
            # Prefer display_name if the server ever adds it (S2).
            display_name=raw.get("display_name") or raw.get("first_name", ""),
        )

    async def get_updates(
        self,
        *,
        offset: int = 0,
        limit: int | None = None,
        timeout_seconds: int | None = None,
    ) -> list[Update]:
        body = {
            "offset": offset,
            "limit": self._clamp_limit(limit),
            "timeout": self._clamp_timeout(timeout_seconds),
        }
        raw = await self._call("getUpdates", body)
        # A missing or malformed result is an empty batch, never a crash: the
        # poll loop must survive a server that answers something unexpected.
        if not isinstance(raw, list):
            return []
        return [update_from_wire(item) for item in raw]

    async def send_message(
        self,
        *,
        chat_id: ChatID,
        text: str,
        reply_to_message_id: MessageID | None = None,
        idempotency_key: str | None = None,
    ) -> BotMessage:
        if not text:
            raise UsageError("send_message requires a non-empty text")
        body: dict[str, Any] = {"chat_id": chat_id, "text": text}
        if reply_to_message_id is not None:
            body["reply_to_message_id"] = reply_to_message_id
        headers = {"Idempotency-Key": idempotency_key} if idempotency_key else None
        return message_from_wire(await self._call("sendMessage", body, headers))

    async def send_chat_action(self, *, chat_id: ChatID, action: ChatAction = "typing") -> bool:
        await self._call("sendChatAction", {"chat_id": chat_id, "action": action})
        return True

    def _clamp_limit(self, limit: int | None) -> int:
        if limit is None or limit == 0:
            return MAX_LIMIT
        if limit < 1:
            # The server answers 400 to these. Rejecting locally, with the
            # reason, beats spending a request to be told the same thing less
            # clearly.
            raise UsageError(f"limit must be at least 1, got {limit}")
        if limit > MAX_LIMIT:
            self._warn(f"limit {limit} clamped to the server maximum of {MAX_LIMIT}")
            return MAX_LIMIT
        return limit

    def _clamp_timeout(self, seconds: int | None) -> int:
        if seconds is None:
            return 0
        if seconds < 0:
            raise UsageError(f"timeout_seconds must not be negative, got {seconds}")
        if seconds > MAX_TIMEOUT_SECONDS:
            self._warn(
                f"timeout_seconds {seconds} clamped to the server maximum of {MAX_TIMEOUT_SECONDS}"
            )
            return MAX_TIMEOUT_SECONDS
        return seconds

    async def _call(
        self,
        method: str,
        body: Any,
        headers: dict[str, str] | None = None,
    ) -> Any:
        url = f"{self._base_url}/bot{self._token}/{method}"
        try:
            response = await self._http.post(url, json=body, headers=headers)
        except Exception as error:  # noqa: BLE001 - the URL is in here either way
            # Redact before it can reach a log.
            raise TransportError(
                f"{method} could not reach the server: "
                f"{redact_exception(error, self._token)}"
            ) from error

        try:
            envelope = response.json()
        except Exception as error:  # noqa: BLE001
            raise TransportError(
                f"{method} returned a body that is not JSON (HTTP {response.status_code}): "
                f"{redact_exception(error, self._token)}"
            ) from error

        if not isinstance(envelope, dict) or not envelope.get("ok"):
            code = (envelope or {}).get("error_code") or response.status_code
            description = (envelope or {}).get("description") or "UNKNOWN"
            raise APIError(code, description, method)
        return envelope.get("result")


def _is_insecure(base_url: str) -> bool:
    """Plaintext to a non-loopback host.

    Loopback only, and deliberately not ``*.local``: mDNS can resolve to a real
    machine on the network, and there the token travels in the clear.
    """
    parsed = urlparse(base_url)
    if parsed.scheme != "http":
        return False
    host = (parsed.hostname or "").lower()
    if host == "localhost" or host.endswith(".localhost"):
        return False
    try:
        return not ipaddress.ip_address(host).is_loopback
    except ValueError:
        return True

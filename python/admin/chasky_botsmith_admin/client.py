"""The management client. Bodies are built field by field, never serialised whole."""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Any, Callable

import httpx

from .errors import AdminError, AdminTransportError, code_for
from .types import (
    BotView,
    Capability,
    CommandKind,
    CommandResult,
    DialogueEvent,
    GrantView,
    Page,
    SecretReveal,
    bot_from_wire,
    event_from_wire,
)


@dataclass(slots=True)
class PageParams:
    """Only cursor and limit exist; the server rejects any other query key."""

    cursor: str | None = None
    limit: int | None = None


@dataclass(slots=True)
class CommandParams:
    command: CommandKind
    expected_revision: int
    value: str | None = None
    bot_id: str | None = None
    expected_credential_version: int | None = None
    #: Reused verbatim on a retry, exactly like the runtime's Idempotency-Key.
    operation_id: str | None = None


class AdminClient:
    def __init__(
        self,
        *,
        base_url: str,
        api_secret: str,
        bearer_token: str | None = None,
        http: httpx.AsyncClient | None = None,
        new_operation_id: Callable[[], str] | None = None,
    ) -> None:
        if not api_secret:
            raise ValueError("an API secret is required")
        self._base_url = base_url.rstrip("/")
        self._api_secret = api_secret
        self._bearer_token = bearer_token
        self._owns_http = http is None
        self._http = http or httpx.AsyncClient(timeout=30)
        self._new_operation_id = new_operation_id or (lambda: str(uuid.uuid4()))

    async def __aenter__(self) -> "AdminClient":
        return self

    async def __aexit__(self, *_exc: object) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        if self._owns_http:
            await self._http.aclose()

    def __repr__(self) -> str:
        # The API secret and the session token must not surface here.
        return f"AdminClient(base_url={self._base_url!r}, <credentials redacted>)"

    async def capability(self) -> Capability:
        data = await self._request("GET", "/capability")
        return Capability(
            enabled=data.get("enabled", False),
            can_manage_administrators=data.get("canManageAdministrators", False),
        )

    async def bots(self, params: PageParams | None = None) -> Page[BotView]:
        data = await self._request("GET", "/bots", page=params)
        return Page(
            items=[bot_from_wire(item) for item in data.get("items") or []],
            has_more=data.get("hasMore", False),
            next_cursor=data.get("nextCursor"),
        )

    async def bot(self, bot_id: str) -> BotView:
        return bot_from_wire(await self._request("GET", f"/bots/{bot_id}"))

    async def dialogue(self, params: PageParams | None = None) -> tuple[DialogueEvent, Page[DialogueEvent]]:
        data = await self._request("GET", "/dialogue", page=params)
        page = Page(
            items=[event_from_wire(item) for item in data.get("items") or []],
            has_more=data.get("hasMore", False),
            next_cursor=data.get("nextCursor"),
        )
        return event_from_wire(data.get("current") or {}), page

    async def command(self, params: CommandParams) -> CommandResult:
        # Built key by key, and ONLY when set.
        #
        # This is where Python differs from the other two SDKs and why the m1
        # case exists: json.dumps writes None as null, and the server rejects a
        # null even where the field is optional. Serialising a dataclass whole
        # would produce 400 INVALID_INPUT for a call the caller wrote correctly.
        body: dict[str, Any] = {
            "operationID": params.operation_id or self._new_operation_id(),
            "expectedRevision": params.expected_revision,
            "command": params.command,
        }
        if params.value is not None:
            body["value"] = params.value
        if params.bot_id is not None:
            body["botID"] = params.bot_id
        if params.expected_credential_version is not None:
            body["expectedCredentialVersion"] = params.expected_credential_version

        data = await self._request("POST", "/commands", body=body)
        secret = data.get("secret")
        return CommandResult(
            event=event_from_wire(data.get("event") or {}),
            secret=SecretReveal(
                bot_id=secret.get("botID", ""),
                token=secret.get("token", ""),
                version=secret.get("version", 0),
            )
            if secret
            else None,
            recovery_required=data.get("recoveryRequired", False),
        )

    async def grant(self, target_id: str, *, enabled: bool, expected_revision: int,
                    operation_id: str | None = None) -> GrantView:
        body = {
            "operationID": operation_id or self._new_operation_id(),
            "expectedRevision": expected_revision,
            "enabled": enabled,
        }
        data = await self._request("PUT", f"/administrators/{target_id}", body=body)
        return GrantView(
            target_id=data.get("targetID", ""),
            revision=data.get("revision", 0),
            enabled=data.get("enabled", False),
        )

    async def _request(
        self,
        method: str,
        path: str,
        *,
        body: dict[str, Any] | None = None,
        page: PageParams | None = None,
    ) -> dict[str, Any]:
        params: dict[str, str] = {}
        if page is not None:
            if page.cursor is not None:
                params["cursor"] = page.cursor
            if page.limit is not None:
                params["limit"] = str(page.limit)

        headers = {"X-Secret": self._api_secret}
        # Bearer OR cookie, never both: the server rejects anything but exactly
        # one Authorization header with exactly two fields, and only falls back
        # to the cookie when the header is absent.
        if self._bearer_token:
            headers["Authorization"] = f"Bearer {self._bearer_token}"

        label = f"{method} {path}"
        try:
            response = await self._http.request(
                method,
                f"{self._base_url}/bot-management{path}",
                params=params or None,
                headers=headers,
                # httpx sets Content-Type: application/json for `json=`, with no
                # charset — which is what the server's media-type check needs.
                json=body if body is not None else None,
            )
        except Exception as error:  # noqa: BLE001
            raise AdminTransportError(f"{label} could not reach the server: {error}") from error

        try:
            envelope = response.json()
        except Exception as error:  # noqa: BLE001
            raise AdminTransportError(
                f"{label} returned a body that is not JSON (HTTP {response.status_code})"
            ) from error

        if not isinstance(envelope, dict) or not envelope.get("ok"):
            code = ((envelope or {}).get("error") or {}).get("code")
            raise AdminError(code_for(code, response.status_code), response.status_code, label)
        return envelope.get("data") or {}

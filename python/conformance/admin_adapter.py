"""Binds the management client to the conformance runner."""

from __future__ import annotations

import dataclasses
import json
from dataclasses import dataclass
from typing import Any, Protocol

from chasky_botsmith_admin import as_developer_key, CommandParams, AdminClient, AdminError, PageParams

TEST_DEVELOPER_KEY = "sk_test"


@dataclass(slots=True)
class ReportedAdminError:
    """What a case asserts on.

    Each SDK's adapter translates its own representation into these fields,
    exactly as it already translates an error code — so a case can state the
    semantics the contract requires without naming any language's error type.
    """

    message: str
    management_code: str | None = None
    retryable: bool | None = None
    access_lost: bool | None = None


class ManagementUnderTest(Protocol):
    results: list[Any]
    errors: list[ReportedAdminError]
    warnings: list[str]

    async def invoke(self, method: str, args: dict[str, Any]) -> None: ...
    def describe(self) -> str: ...
    async def aclose(self) -> None: ...


class SDKManagement:
    def __init__(self, base_url: str) -> None:
        self.results: list[Any] = []
        self.errors: list[ReportedAdminError] = []
        self.warnings: list[str] = []
        self._client = AdminClient(
            base_url=base_url,
            developer_key=as_developer_key(TEST_DEVELOPER_KEY),
        )

    async def invoke(self, method: str, args: dict[str, Any]) -> None:
        try:
            self.results.append(await self._call(method, args))
        except AdminError as error:
            self.errors.append(
                ReportedAdminError(
                    message=str(error),
                    management_code=error.code,
                    retryable=error.retryable,
                    access_lost=error.access_lost,
                )
            )
        except Exception as error:  # noqa: BLE001
            self.errors.append(ReportedAdminError(message=str(error)))

    async def _call(self, method: str, args: dict[str, Any]) -> Any:
        if method == "capability":
            return await self._client.capability()
        if method == "bots":
            return await self._client.bots(PageParams(cursor=args.get("cursor"), limit=args.get("limit")))
        if method == "bot":
            return await self._client.bot(str(args["id"]))
        if method == "dialogue":
            return await self._client.dialogue(PageParams(cursor=args.get("cursor"), limit=args.get("limit")))
        if method == "command":
            return await self._client.command(
                CommandParams(
                    command=args["command"],
                    expected_revision=args.get("expectedRevision", 0),
                    value=args.get("value"),
                    bot_id=args.get("botID"),
                    expected_credential_version=args.get("expectedCredentialVersion"),
                    operation_id=args.get("operationID"),
                )
            )
        if method == "createBot":
            from chasky_botsmith_admin import CreateBotParams

            return await self._client.create_bot(
                CreateBotParams(name=str(args["name"]), username=str(args["username"]))
            )
        if method == "developerKeys":
            return await self._client.developer_keys()
        if method == "grant":
            return await self._client.grant(
                str(args["targetId"]),
                enabled=bool(args.get("enabled")),
                expected_revision=args.get("expectedRevision", 0),
            )
        raise ValueError(f"unknown management method: {method}")

    def describe(self) -> str:
        return f"{self._client!r} {self._client}"

    async def aclose(self) -> None:
        await self._client.aclose()


def factory(base_url: str) -> ManagementUnderTest:
    return SDKManagement(base_url)


def encode(value: Any) -> str:
    """Render anything for a substring check, looking INSIDE dataclasses.

    Falling back to repr() here was wrong in a way worth remembering: the SDK
    deliberately redacts ``CommandResult.__repr__`` and ``SecretReveal.__repr__``
    so a token cannot land in a log. That protection then hid the token from the
    runner's own ``secretReturnedOnce`` check, and m4 failed claiming the token
    never reached the caller — when it had.

    asdict() walks the fields without calling __repr__, so the check inspects the
    real values while the redaction still protects every log path.
    """

    def fallback(obj: Any) -> Any:
        if dataclasses.is_dataclass(obj) and not isinstance(obj, type):
            return dataclasses.asdict(obj)
        return repr(obj)

    try:
        return json.dumps(value, default=fallback)
    except (TypeError, ValueError):
        return repr(value)

"""Binds the management client to the conformance runner."""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Protocol

from chasky_botsmith.management import CommandParams, ManagementClient, ManagementError, PageParams

TEST_API_SECRET = "test-api-secret"
TEST_BEARER = "test-session-bearer"


@dataclass(slots=True)
class ReportedManagementError:
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
    errors: list[ReportedManagementError]
    warnings: list[str]

    async def invoke(self, method: str, args: dict[str, Any]) -> None: ...
    def describe(self) -> str: ...
    async def aclose(self) -> None: ...


class SDKManagement:
    def __init__(self, base_url: str) -> None:
        self.results: list[Any] = []
        self.errors: list[ReportedManagementError] = []
        self.warnings: list[str] = []
        self._client = ManagementClient(
            base_url=base_url,
            api_secret=TEST_API_SECRET,
            bearer_token=TEST_BEARER,
        )

    async def invoke(self, method: str, args: dict[str, Any]) -> None:
        try:
            self.results.append(await self._call(method, args))
        except ManagementError as error:
            self.errors.append(
                ReportedManagementError(
                    message=str(error),
                    management_code=error.code,
                    retryable=error.retryable,
                    access_lost=error.access_lost,
                )
            )
        except Exception as error:  # noqa: BLE001
            self.errors.append(ReportedManagementError(message=str(error)))

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
    """Render anything for a substring check, dataclasses included."""
    try:
        return json.dumps(value, default=repr)
    except (TypeError, ValueError):
        return repr(value)

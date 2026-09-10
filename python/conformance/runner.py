"""Loads cases, drives a bot against the fake, and reports what went wrong."""

from __future__ import annotations

import asyncio
import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import parse_qsl
from typing import Any, Callable, Protocol

from .fake import FakeServer
from .admin_adapter import ManagementUnderTest, encode
from .admin_adapter import factory as sdk_management_factory
from .matchers import Captures, match_headers, match_partial

#: A fixed test credential. Never a real token; cases refer to it as {token}.
TEST_TOKEN = "bot:b1:" + "0" * 64

DEFAULT_TIMEOUT = 5.0
#: After the exchanges run out, how long to watch for a request that should not come.
IDLE_GRACE = 0.2

_BOT_PATH = re.compile(r"/bot[^/\s]+")


@dataclass(slots=True)
class Failure:
    where: str
    detail: str

    def __str__(self) -> str:
        return f"{self.where}: {self.detail}"


@dataclass(slots=True)
class ReportedError:
    message: str
    code: int | None = None


@dataclass(slots=True)
class BotOptions:
    base_url: str
    token: str
    limit: int | None
    timeout_seconds: int | None
    handler: dict[str, Any]


class BotUnderTest(Protocol):
    """The contract between this runner and an SDK under test.

    Kept this thin on purpose: anything richer would let a case assert
    something idiomatic, and cases must only ever verify observable behaviour.
    """

    stopped_itself: bool
    handler_runs: dict[int, int]
    errors: list[ReportedError]
    warnings: list[str]

    async def start(self) -> None: ...
    async def stop(self) -> None: ...


Factory = Callable[[BotOptions], BotUnderTest]


def load_cases(directory: Path) -> list[dict[str, Any]]:
    """Sorted, so failures report in a stable order across runs and languages."""
    return [json.loads(path.read_text()) for path in sorted(directory.glob("*.json"))]


async def run_case(
    case: dict[str, Any],
    factory: Factory,
    management_factory: Any = None,
) -> list[Failure]:
    if case.get("kind") == "management":
        return await run_management_case(case, management_factory or sdk_management_factory)

    fake = FakeServer(case["exchanges"])
    failures: list[Failure] = []
    bot: BotUnderTest | None = None
    try:
        options = case["bot"].get("options", {})
        bot = factory(
            BotOptions(
                base_url=fake.base_url,
                token=TEST_TOKEN,
                limit=options.get("limit"),
                timeout_seconds=options.get("timeoutSeconds"),
                handler=case["bot"]["handler"],
            )
        )
        await bot.start()
        timeout = case.get("run", {}).get("timeoutMs", DEFAULT_TIMEOUT * 1000) / 1000
        await _wait_for_completion(bot, fake, timeout)
    finally:
        if bot is not None:
            try:
                await bot.stop()
            except Exception:  # noqa: BLE001 - stopping must never mask a real failure
                pass
        fake.close()

    failures.extend(_check_requests(case, fake))
    if bot is not None:
        failures.extend(_check_assertions(case, bot))
    return failures


async def run_management_case(case: dict[str, Any], factory: Any) -> list[Failure]:
    """Invoke methods in order; nothing polls, so there is no loop to wait on.

    The exchange list and every matcher work exactly as they do for the runtime.
    That reuse is why both kinds share one format.
    """
    fake = FakeServer(case["exchanges"])
    failures: list[Failure] = []
    client: ManagementUnderTest | None = None
    try:
        client = factory(fake.base_url)
        for call in case.get("calls", []):
            await client.invoke(call["method"], call.get("args") or {})
    finally:
        if client is not None:
            await client.aclose()
        fake.close()

    failures.extend(_check_requests(case, fake))
    if client is not None:
        failures.extend(_check_management_assertions(case, client))
    return failures


def _check_management_assertions(case: dict[str, Any], client: ManagementUnderTest) -> list[Failure]:
    failures: list[Failure] = []
    want = case.get("assert", {})

    for index, expected in enumerate(want.get("errorsReported", [])):
        if index >= len(client.errors):
            failures.append(
                Failure("assert.errorsReported", f"expected an error at position {index}, none was reported")
            )
            continue
        actual = client.errors[index]
        checks = (
            ("managementCode", "management_code"),
            ("retryable", "retryable"),
            ("accessLost", "access_lost"),
        )
        for case_field, attr in checks:
            if expected.get(case_field) is not None and getattr(actual, attr) != expected[case_field]:
                failures.append(
                    Failure(
                        "assert.errorsReported",
                        f"error #{index + 1}: expected {case_field}={expected[case_field]}, "
                        f"got {getattr(actual, attr)}",
                    )
                )
    if not want.get("errorsReported") and client.errors:
        codes = [error.management_code or error.message for error in client.errors]
        failures.append(Failure("assert.errorsReported", f"expected no errors, got {codes}"))

    created = want.get("createdBotId")
    if created:
        if not any(getattr(result, "bot_id", None) == created for result in client.results):
            failures.append(
                Failure("assert.createdBotId", f"expected the facade to report creating {created}")
            )

    secret = want.get("secretReturnedOnce")
    if secret:
        if secret not in encode(client.results):
            failures.append(Failure("assert.secretReturnedOnce", "the revealed token never reached the caller"))
        # The one response carrying a live token is response-only by the server's
        # own design. If the SDK lets it reach a log line, an error, or its own
        # representation, it undoes the only protection built for it.
        places = {
            "errors": encode(client.errors),
            "warnings": encode(client.warnings),
            "repr": client.describe(),
        }
        for place in want.get("secretNotIn", []):
            if secret in places.get(place, ""):
                failures.append(
                    Failure(
                        "assert.secretNotIn",
                        f"the revealed token LEAKED into {place}; it must reach the return value only",
                    )
                )
    return failures


async def _wait_for_completion(bot: BotUnderTest, fake: FakeServer, timeout: float) -> None:
    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        if bot.stopped_itself:
            # Even a stopped bot is watched briefly: one that reports the error
            # and keeps polling is exactly the g7-409 failure this suite exists
            # to catch.
            await asyncio.sleep(IDLE_GRACE)
            return
        if fake.exhausted:
            await asyncio.sleep(IDLE_GRACE)
            return
        await asyncio.sleep(0.01)


def _check_requests(case: dict[str, Any], fake: FakeServer) -> list[Failure]:
    failures: list[Failure] = []
    captures: Captures = {}
    observed = fake.observed
    exchanges = case["exchanges"]

    # Per-request problems, collapsed at the end so one defect reads as one
    # line: the idle steady state repeats the same poll many times.
    problems: list[tuple[int, str]] = []

    repeats = bool(exchanges) and bool(exchanges[-1].get("repeat"))
    total = max(len(exchanges), len(observed)) if repeats else len(exchanges)

    for index in range(total):
        expected = exchanges[min(index, len(exchanges) - 1)]["expect"]
        if index >= len(observed):
            problems.append(
                (
                    index + 1,
                    f"expected {expected.get('method', 'POST')} {redact(expected.get('path', '?'))}, "
                    "but the SDK never sent it",
                )
            )
            continue
        actual = observed[index]
        if expected.get("method") and expected["method"] != actual.method:
            problems.append((index + 1, f"expected method {expected['method']}, got {actual.method}"))
        # The observed path carries the query string; the case declares them
        # separately so a query can be partially matched like a body.
        actual_path, _, actual_query = actual.path.partition("?")
        if expected.get("path"):
            want = expected["path"].replace("{token}", TEST_TOKEN)
            if want != actual_path:
                problems.append(
                    (index + 1, f"expected path {redact(want)}, got {redact(actual_path)}")
                )
        if expected.get("query"):
            observed = {k: v for k, v in parse_qsl(actual_query)}
            reason = match_partial(expected["query"], observed, captures, "query")
            if reason:
                problems.append((index + 1, reason))
        if expected.get("headers"):
            reason = match_headers(expected["headers"], actual.headers, captures)
            if reason:
                problems.append((index + 1, reason))
        if expected.get("body"):
            reason = match_partial(expected["body"], actual.body, captures, "body")
            if reason:
                problems.append((index + 1, reason))

    grouped: dict[str, list[int]] = {}
    for index, detail in problems:
        grouped.setdefault(detail, []).append(index)
    for detail, indexes in grouped.items():
        where = f"request #{indexes[0]}"
        if len(indexes) > 1:
            where = f"requests #{indexes[0]}-#{indexes[-1]} ({len(indexes)} times)"
        failures.append(Failure(where, detail))

    extras = fake.extras
    if extras:
        shown = [f"{e.method} {redact(e.path)}" for e in extras[:3]]
        rest = len(extras) - len(shown)
        more = f", +{rest} more" if rest > 0 else ""
        failures.append(
            Failure(
                "unexpected requests",
                f"the SDK sent {len(extras)} request(s) after the last declared exchange "
                f"({', '.join(shown)}{more}). The exchange list is exhaustive: nothing may "
                "follow it.",
            )
        )
    return failures


def _check_assertions(case: dict[str, Any], bot: BotUnderTest) -> list[Failure]:
    failures: list[Failure] = []
    want = case.get("assert", {})

    if "botStopped" in want and want["botStopped"] != bot.stopped_itself:
        detail = (
            "expected the bot to stop on its own, but it was still running"
            if want["botStopped"]
            else "expected the bot to keep running, but it stopped on its own"
        )
        failures.append(Failure("assert.botStopped", detail))

    for run in want.get("handlerRuns", []):
        got = bot.handler_runs.get(run["updateId"], 0)
        if got != run["times"]:
            failures.append(
                Failure(
                    "assert.handlerRuns",
                    f"update {run['updateId']}: expected {run['times']} run(s), got {got}",
                )
            )

    for index, expected in enumerate(want.get("errorsReported", [])):
        if index >= len(bot.errors):
            failures.append(
                Failure("assert.errorsReported", f"expected an error at position {index}, none was reported")
            )
            continue
        actual = bot.errors[index]
        if expected.get("code") is not None and actual.code != expected["code"]:
            failures.append(
                Failure(
                    "assert.errorsReported",
                    f"error #{index + 1}: expected code {expected['code']}, got {actual.code}",
                )
            )
        if expected.get("notContains"):
            needle = expected["notContains"].replace("{token}", TEST_TOKEN)
            if needle in actual.message:
                failures.append(
                    Failure(
                        "assert.errorsReported",
                        f"error #{index + 1} LEAKS the token. An error crossing the SDK "
                        "boundary must be redacted first.",
                    )
                )

    for warning in want.get("warnings", []):
        if not any(warning["contains"].lower() in w.lower() for w in bot.warnings):
            failures.append(
                Failure(
                    "assert.warnings",
                    f"expected a warning containing {warning['contains']!r}, got {bot.warnings or 'none'}",
                )
            )
    return failures


def redact(text: str) -> str:
    """The runner prints paths, and paths carry the token."""
    return _BOT_PATH.sub("/bot<TOKEN>", text.replace(TEST_TOKEN, "<TOKEN>"))

"""The polling transport, and the seam for D4."""

from __future__ import annotations

import asyncio
import random
from dataclasses import dataclass
from typing import Awaitable, Callable, Protocol

from .client import Client
from .errors import classify
from .types import Update


@dataclass(slots=True)
class TransportDeps:
    client: Client
    #: Called once per NEW update, in ascending order. May raise; the loop
    #: survives.
    on_update: Callable[[Update], Awaitable[None]]
    #: Recoverable problems, already redacted.
    on_error: Callable[[BaseException], None]


class Transport(Protocol):
    """Polling is the only implementation today.

    When the server grows outbound webhooks, a Webhook transport joins it and
    the caller's handlers do not change. That is the whole promise — nothing
    about the webhook's shape is committed here, because the server has not
    built it.
    """

    kind: str

    async def run(self, deps: TransportDeps) -> None:
        """Return on cancellation; raise the terminal failure."""
        ...


class Polling:
    kind = "polling"

    def __init__(
        self,
        *,
        limit: int | None = None,
        timeout_seconds: int | None = None,
        retry_base: float = 0.25,
        retry_max: float = 8.0,
    ) -> None:
        self._limit = limit
        self._timeout_seconds = timeout_seconds
        self._retry_base = retry_base
        self._retry_max = retry_max

    async def run(self, deps: TransportDeps) -> None:
        # The ENTIRE state of the loop: one integer.
        #
        # It is both the dedup threshold (G3) and the source of the offset
        # (G2), which are the same number — offset == last_seen + 1 holds at
        # all times. Keeping two fields in sync would be a bug waiting for the
        # day they diverge.
        last_seen = -1
        failures = 0

        while True:
            try:
                batch = await deps.client.get_updates(
                    offset=last_seen + 1,
                    limit=self._limit,
                    timeout_seconds=self._timeout_seconds,
                )
                failures = 0
            except asyncio.CancelledError:
                raise
            except Exception as error:  # noqa: BLE001 - classify decides
                if classify(error, "poll") == "terminal":
                    # 401, 403 and 409 while polling all mean the same thing:
                    # this bot will not be allowed to poll. Retrying a 409 in
                    # particular is an eviction war — two instances displacing
                    # each other forever, neither processing anything (§3.1).
                    raise
                deps.on_error(error)
                failures += 1
                await asyncio.sleep(_backoff(failures, self._retry_base, self._retry_max))
                continue

            for update in batch:
                # G3: a threshold, not a data structure. The server delivers in
                # strictly ascending order and emits no regressive ids, so
                # anything at or below the threshold is a redelivery —
                # including a full stream replay after the consumer group is
                # recreated, where a finite window would fail.
                if update.update_id <= last_seen:
                    continue

                # G2, and the order is the point: the cursor advances BEFORE
                # the handler runs, so a handler that raises cannot pin the bot
                # on one update forever. The offset is a read cursor, not a
                # business acknowledgement.
                last_seen = update.update_id

                try:
                    await deps.on_update(update)
                except asyncio.CancelledError:
                    raise
                except Exception as error:  # noqa: BLE001 - the author's bug, reported
                    deps.on_error(error)


def _backoff(attempt: int, base: float, maximum: float) -> float:
    delay = min(maximum, base * 2 ** (attempt - 1))
    # Jitter so many bots recovering from one outage do not resynchronise into
    # a thundering herd against the API.
    return delay * (0.5 + random.random() * 0.5)

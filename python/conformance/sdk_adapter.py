"""Binds chasky_botsmith to the conformance runner."""

from __future__ import annotations

import asyncio

from chasky_botsmith import APIError, Bot, Event, Polling

from .runner import BotOptions, BotUnderTest, ReportedError


class SDKBot:
    def __init__(self, options: BotOptions) -> None:
        self.stopped_itself = False
        self.handler_runs: dict[int, int] = {}
        self.errors: list[ReportedError] = []
        self.warnings: list[str] = []
        self._task: asyncio.Task[None] | None = None

        spec = options.handler
        self._bot = Bot(
            options.token,
            base_url=options.base_url,
            transport=Polling(
                limit=options.limit,
                timeout_seconds=options.timeout_seconds,
                # Short so a case exercising a retry finishes inside its timeout.
                retry_base=0.02,
                retry_max=0.2,
            ),
            on_warning=self.warnings.append,
        )

        @self._bot.on_text
        async def handle(event: Event) -> None:
            update_id = event.update.update_id
            self.handler_runs[update_id] = self.handler_runs.get(update_id, 0) + 1
            if update_id in (spec.get("throwOnUpdateIds") or []):
                raise RuntimeError(f"handler failed on update {update_id}")
            if spec.get("kind") == "noop":
                return
            await event.reply(spec.get("replyText") or event.message.text)

        self._bot.on_error(self._record)

    async def start(self) -> None:
        self._task = asyncio.create_task(self._run())

    async def _run(self) -> None:
        try:
            await self._bot.run()
        except asyncio.CancelledError:
            raise
        except Exception as error:  # noqa: BLE001 - terminal, by contract
            self.stopped_itself = True
            # A terminal failure is also an error the caller sees: cases assert
            # on it by position in `errors`, so hiding it would make those
            # assertions untestable.
            self._record(error)

    async def start_again(self) -> BaseException | None:
        """Await run() directly instead of spawning a second task.

        A bot that is already running raises before it awaits anything, which is
        the answer this asks for; one that is not would block, so this is only
        ever called after start() has taken hold.
        """
        try:
            await self._bot.run()
        except Exception as error:  # noqa: BLE001
            return error
        return None

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
        await self._bot.aclose()

    def _record(self, error: BaseException) -> None:
        code = error.code if isinstance(error, APIError) else None
        self.errors.append(ReportedError(message=str(error), code=code))


def factory(options: BotOptions) -> BotUnderTest:
    return SDKBot(options)

"""Binds chasky_botsmith to the conformance runner."""

from __future__ import annotations

import asyncio

from typing import Any

from chasky_botsmith import APIError, Attachment, Bot, Event, Polling, Update

from .runner import BotOptions, BotUnderTest, ReportedError


class SDKBot:
    def __init__(self, options: BotOptions) -> None:
        self.stopped_itself = False
        self.handler_runs: dict[int, int] = {}
        self.errors: list[ReportedError] = []
        self.warnings: list[str] = []
        self.attachments_seen: list[dict[str, Any]] = []
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

        # Counted in the catch-all hook, so an update kind the SDK has no type
        # for is counted too (G10).
        @self._bot.on_update
        async def count(update: Update) -> None:
            self.handler_runs[update.update_id] = self.handler_runs.get(update.update_id, 0) + 1

        @self._bot.on_text
        async def handle(event: Event) -> None:
            update_id = event.update.update_id
            if update_id in (spec.get("throwOnUpdateIds") or []):
                raise RuntimeError(f"handler failed on update {update_id}")
            if spec.get("kind") == "noop":
                return
            # No mentions at all when the message had none: the SDK must not
            # send the key empty (G12).
            mentions = (
                {m.name: m.user_id for m in event.message.mentions}
                if spec.get("mentionBack")
                else None
            )
            await event.reply(spec.get("replyText") or event.message.text, mentions=mentions)

        if spec.get("recordAttachments"):

            @self._bot.on_attachment
            async def record(event: Event) -> None:
                attachments = []
                for attachment in event.message.attachments:
                    seen = _wire_attachment(attachment)
                    if spec.get("downloadAttachments"):
                        seen["downloadedBytes"] = await _count_bytes(self._bot, attachment)
                    attachments.append(seen)
                # Back into wire names, so the case compares one shape across
                # languages (SCHEMA.md, attachmentsSeen).
                self.attachments_seen.append(
                    {
                        "updateId": event.update.update_id,
                        "text": event.message.text,
                        "caption": event.message.caption,
                        "attachmentsTruncated": event.message.attachments_truncated,
                        "attachments": attachments,
                    }
                )

        for name, reply_text in (spec.get("commands") or {}).items():
            self._bot.command(name)(_replying(reply_text))

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


def _wire_attachment(a: Attachment) -> dict[str, Any]:
    wire: dict[str, Any] = {
        "file_id": a.file_id,
        "kind": a.kind,
        "file_name": a.file_name,
        "mime_type": a.mime_type,
        "file_size": a.file_size,
        "url": a.url,
    }
    for name in ("width", "height", "duration"):
        value = getattr(a, name)
        if value is not None:
            wire[name] = value
    return wire


async def _count_bytes(bot: Bot, attachment: Attachment) -> int:
    total = 0
    async with bot.client.download(attachment) as chunks:
        async for chunk in chunks:
            total += len(chunk)
    return total


def _replying(text: str):  # noqa: ANN202 - a handler factory
    async def handle(event: Event) -> None:
        await event.reply(text)

    return handle


def factory(options: BotOptions) -> BotUnderTest:
    return SDKBot(options)

"""Ergonomic wrappers over the dialogue.

NOTE — a bot created here is PRIVATE. Since server delta 15, new bots default to
private: they do not appear in directory search, and the opener answers 404 to
anyone but the owner. That is deliberate on the server's side — a bot stays
undiscoverable while you test it, and publishing is a separate, conscious act. A
caller who expects ``create_bot`` to produce something people can find has to
follow it with the ``publish`` command.

``/bot-management/commands`` is a conversational state machine: creating a bot is
``/newbot``, the name, the username, ``confirm`` — four chained POSTs, each
carrying the revision the last one returned. That is the right shape for a person
typing in a portal and a hostile one for a CI job.

Absorbing it is the same job the runtime does with offset arithmetic and
idempotency keys: the caller says what they want once, the SDK deals with the
protocol.

Two things this cannot hide, so it does not pretend to:

* It is still four round trips. Fine for provisioning, wrong for a hot path.
* The dialogue is ONE shared conversation per actor, guarded by
  ``expectedRevision``. If a person has the portal open, or another process is
  driving it, the revision moves underneath and the server answers
  ``STALE_STATE``. This retries from a fresh read a bounded number of times and
  then gives up rather than fighting for the conversation.
"""

from __future__ import annotations

from dataclasses import dataclass

from .errors import AdminError
from .types import DialogueEvent


@dataclass(slots=True)
class CreateBotParams:
    name: str
    username: str
    #: Attempts when another writer moves the revision underneath us.
    stale_retries: int = 2


@dataclass(slots=True)
class CreateBotResult:
    bot_id: str
    event: DialogueEvent


async def create_bot(client: "object", params: CreateBotParams) -> CreateBotResult:
    """Create a bot in one call, driving the four-step dialogue."""
    last: BaseException | None = None
    for _attempt in range(params.stale_retries + 1):
        try:
            return await _run_create(client, params)
        except AdminError as error:
            last = error
            if error.code != "STALE_STATE":
                raise
            # Someone else advanced the conversation. Re-read and walk it again.
    assert last is not None
    raise last


async def _run_create(client, params: CreateBotParams) -> CreateBotResult:  # type: ignore[no-untyped-def]
    from .client import CommandParams, PageParams

    current, _events = await client.dialogue(PageParams(limit=1))
    revision = current.revision
    started = False

    try:
        step = await client.command(CommandParams(command="/newbot", expected_revision=revision))
        started = True
        revision = step.event.revision

        # The server normalises both values and can answer with something other
        # than what went in, so each step's revision comes from ITS response
        # rather than from counting.
        step = await client.command(
            CommandParams(command="value", value=params.name, expected_revision=revision)
        )
        revision = step.event.revision

        step = await client.command(
            CommandParams(command="value", value=params.username, expected_revision=revision)
        )
        revision = step.event.revision

        step = await client.command(CommandParams(command="confirm", expected_revision=revision))
        bot_id = step.event.receipt.bot_id
        if not bot_id:
            raise ValueError("the dialogue confirmed a bot but returned no botID; refusing to guess one")
        return CreateBotResult(bot_id=bot_id, event=step.event)
    except BaseException:
        # Driving a shared conversation means owning its cleanup. Left alone, the
        # next person to open the portal finds it parked on "enter a username"
        # for a bot they never asked for.
        if started:
            await _cancel_quietly(client, revision)
        raise


async def _cancel_quietly(client, revision: int) -> None:  # type: ignore[no-untyped-def]
    from .client import CommandParams

    try:
        await client.command(CommandParams(command="/cancel", expected_revision=revision))
    except Exception:  # noqa: BLE001
        # The original failure is the one worth reporting. A cleanup that also
        # fails must not replace it, or the caller learns about the wrong problem.
        pass

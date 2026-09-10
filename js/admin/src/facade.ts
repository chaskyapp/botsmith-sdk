import type { AdminClient } from "./client.js";
import { AdminError } from "./errors.js";
import type { DialogueEvent } from "./types.js";

/**
 * Ergonomic wrappers over the dialogue.
 *
 * NOTE — a bot created here is PRIVATE. Since server delta 15, new bots default
 * to private: they do not appear in directory search, and the opener answers 404
 * to anyone but the owner. That is deliberate on the server's side — a bot stays
 * undiscoverable while you test it, and publishing is a separate, conscious act.
 * A caller who expects `createBot` to produce something people can find has to
 * follow it with the `publish` command.
 *
 * `/bot-management/commands` is a conversational state machine: creating a bot
 * is /newbot, the name, the username, confirm — four chained POSTs, each
 * carrying the revision the last one returned. That is the right shape for a
 * person typing in a portal and a hostile one for a CI job.
 *
 * Absorbing it is the same job the runtime does with offset arithmetic and
 * idempotency keys: the caller says what they want once, and the SDK deals with
 * the protocol.
 *
 * Two things this cannot hide, so it does not pretend to:
 *
 *  - It is still four round trips. Fine for provisioning, wrong for a hot path.
 *  - The dialogue is ONE shared conversation per actor, guarded by
 *    `expectedRevision`. If a person has the portal open, or another process is
 *    driving it, the revision moves underneath and the server answers
 *    STALE_STATE. This retries from a fresh read a bounded number of times, and
 *    then gives up rather than fighting for the conversation.
 */

export interface CreateBotParams {
  name: string;
  username: string;
  /** Attempts when another writer moves the revision underneath us. */
  staleRetries?: number;
}

export interface CreateBotResult {
  botId: string;
  event: DialogueEvent;
}

export async function createBot(client: AdminClient, params: CreateBotParams): Promise<CreateBotResult> {
  const retries = params.staleRetries ?? 2;
  for (let attempt = 0; ; attempt++) {
    try {
      return await runCreate(client, params);
    } catch (error) {
      const stale = error instanceof AdminError && error.code === "STALE_STATE";
      if (!stale || attempt >= retries) throw error;
      // Someone else advanced the conversation. Re-read and walk it again.
    }
  }
}

async function runCreate(client: AdminClient, params: CreateBotParams): Promise<CreateBotResult> {
  const { current } = await client.dialogue({ limit: 1 });
  let revision = current.revision;
  let started = false;

  try {
    let result = await client.command({ command: "/newbot", expectedRevision: revision });
    started = true;
    revision = result.event.revision;

    // The server normalises both values and can answer with something other
    // than what went in, so each step's revision comes from ITS response rather
    // than from counting.
    result = await client.command({ command: "value", value: params.name, expectedRevision: revision });
    revision = result.event.revision;

    result = await client.command({ command: "value", value: params.username, expectedRevision: revision });
    revision = result.event.revision;

    result = await client.command({ command: "confirm", expectedRevision: revision });
    const botId = result.event.receipt.botID;
    if (!botId) {
      throw new Error("the dialogue confirmed a bot but returned no botID; refusing to guess one");
    }
    return { botId, event: result.event };
  } catch (error) {
    // Driving a shared conversation means owning its cleanup. Left alone, the
    // next person to open the portal finds it parked on "enter a username" for
    // a bot they never asked for.
    if (started) await cancelQuietly(client, revision);
    throw error;
  }
}

async function cancelQuietly(client: AdminClient, revision: number): Promise<void> {
  try {
    await client.command({ command: "/cancel", expectedRevision: revision });
  } catch {
    // The original failure is the one worth reporting. A cleanup that also
    // fails must not replace it, or the caller learns about the wrong problem.
  }
}

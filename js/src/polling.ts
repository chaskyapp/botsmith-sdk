import type { ChaskyBotClient } from "./client.js";
import { classify } from "./errors.js";
import type { Update } from "./types.js";

export interface TransportDeps {
  client: ChaskyBotClient;
  /** Called once per NEW update, in ascending order. May throw; the loop survives. */
  onUpdate: (update: Update) => Promise<void>;
  /** Recoverable problems, already redacted. */
  onError: (error: unknown) => void;
  /** The bot cannot continue. Called once, then the loop ends. */
  onFatal: (error: unknown) => void;
  signal: AbortSignal;
}

/**
 * The seam for D4. Today `polling` is the only implementation; when the server
 * grows outbound webhooks, `webhook()` joins it and the author's handlers do not
 * change. That is the whole promise — nothing about the webhook's shape is
 * committed here, because the server has not built it.
 */
export interface Transport {
  readonly kind: string;
  run(deps: TransportDeps): Promise<void>;
}

export interface PollingOptions {
  limit?: number | undefined;
  timeoutSeconds?: number | undefined;
  /** First retry delay for transient failures; doubles, with jitter. */
  retryBaseMs?: number | undefined;
  retryMaxMs?: number | undefined;
}

export function polling(options: PollingOptions = {}): Transport {
  return {
    kind: "polling",
    run: (deps) => runPollingLoop(options, deps),
  };
}

async function runPollingLoop(options: PollingOptions, deps: TransportDeps): Promise<void> {
  const { client, onUpdate, onError, onFatal, signal } = deps;
  const baseMs = options.retryBaseMs ?? 250;
  const maxMs = options.retryMaxMs ?? 8000;

  /**
   * The ENTIRE state of the loop: one integer.
   *
   * It is both the dedup threshold (G3) and the source of the offset (G2), which
   * are the same number — `offset === lastSeen + 1` holds at all times. Keeping
   * two fields in sync would be a bug waiting for the day they diverge.
   */
  let lastSeen = -1;
  let consecutiveFailures = 0;

  while (!signal.aborted) {
    let batch: Update[];
    try {
      batch = await client.getUpdates(
        { offset: lastSeen + 1, limit: options.limit, timeoutSeconds: options.timeoutSeconds },
        signal,
      );
      consecutiveFailures = 0;
    } catch (error) {
      if (signal.aborted) return;
      if (classify(error, "poll") === "terminal") {
        // 401, 403 and 409 while polling all mean the same thing: this bot is
        // not going to be allowed to poll. Retrying a 409 in particular is an
        // eviction war — two instances displacing each other forever, neither
        // processing anything (§3.1).
        onFatal(error);
        return;
      }
      onError(error);
      consecutiveFailures++;
      await sleep(backoffMs(consecutiveFailures, baseMs, maxMs), signal);
      continue;
    }

    for (const update of batch) {
      if (signal.aborted) return;
      // G3: a threshold, not a data structure. The server delivers in strictly
      // ascending order and emits no regressive ids, so anything at or below the
      // threshold is a redelivery — including a full stream replay after the
      // consumer group is recreated, where a finite window would fail.
      if (update.updateId <= lastSeen) continue;

      // G2, and the order is the point: the cursor advances BEFORE the handler
      // runs, so a handler that throws cannot pin the bot on one update forever.
      // `offset` is a read cursor, not a business acknowledgement.
      lastSeen = update.updateId;

      try {
        await onUpdate(update);
      } catch (error) {
        onError(error);
      }
    }
  }
}

function backoffMs(attempt: number, baseMs: number, maxMs: number): number {
  const exponential = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
  // Jitter so that many bots recovering from one outage do not resynchronise
  // into a thundering herd against the API.
  return Math.round(exponential * (0.5 + Math.random() * 0.5));
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    }
    signal?.addEventListener("abort", finish, { once: true });
  });
}

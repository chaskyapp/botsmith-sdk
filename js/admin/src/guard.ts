/**
 * Three layers keeping the platform secret out of a browser bundle.
 *
 * They exist because the failure they prevent is not "an error at runtime" but
 * "the secret is now in every visitor's devtools", which is unrecoverable by
 * anything except rotating a credential the whole platform shares.
 *
 *  1. The package's `exports` map blocks the `browser` condition, so a bundler
 *     refuses to resolve it for a client build. That is the strongest layer,
 *     because it fails at BUILD time.
 *  2. This runtime guard, for the cases a bundler cannot see through — a dynamic
 *     import, a misconfigured bundler, a runtime that lies about its target.
 *  3. `PlatformSecret` below, which makes the value awkward enough to pass that
 *     nobody does it by accident.
 *
 * In Next.js the caller can add a fourth: `import "server-only"` at the top of
 * whatever wraps this. That breaks the build if a client component ever reaches
 * it, which is better than any check this package can make about itself.
 */

/**
 * A string that has been consciously acknowledged as the platform secret.
 *
 * The brand costs one explicit call, and buys a line of code that reads wrong
 * when it is in the wrong place: seeing `asPlatformSecret(...)` in a React
 * component is a louder signal than seeing a bare string.
 */
declare const platformSecretBrand: unique symbol;
export type PlatformSecret = string & { readonly [platformSecretBrand]: true };

export function asPlatformSecret(value: string): PlatformSecret {
  if (!value) throw new Error("the platform secret must not be empty");
  return value as PlatformSecret;
}

/** Thrown when the admin client is constructed somewhere it must never run. */
export class ServerOnlyError extends Error {
  constructor() {
    super(
      "@chasky/botsmith-admin is server-only: it carries the platform API secret, " +
        "which must never reach a browser. If you need bot functionality in the " +
        "client, that is @chasky/botsmith and a bot token.",
    );
    this.name = "ServerOnlyError";
  }
}

/**
 * Refuses to run in a browser-like environment.
 *
 * `typeof window` is not proof — a worker has no window, and a server can be
 * made to have one — so this is a net, not a wall. The wall is the exports map.
 */
export function assertServerOnly(): void {
  const looksLikeBrowser =
    typeof globalThis === "object" &&
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    typeof (globalThis as any).window !== "undefined" &&
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    typeof (globalThis as any).document !== "undefined";
  if (looksLikeBrowser) throw new ServerOnlyError();
}

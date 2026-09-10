/**
 * Three layers keeping a developer key out of a browser bundle.
 *
 * They exist because the failure they prevent is not "an error at runtime" but
 * "the key is now in every visitor's devtools", and a key administers bots:
 * whoever has it can create them, rotate their tokens, point their webhooks at
 * their own server and read the conversations.
 *
 * This is recoverable — revoke the key, issue another — which the platform
 * secret it replaces was not. That is an argument for keys, not for dropping
 * the layers: recoverable still means someone has to notice first.
 *
 *  1. The package's `exports` map blocks the `browser` condition, so a bundler
 *     refuses to resolve it for a client build. That is the strongest layer,
 *     because it fails at BUILD time.
 *  2. This runtime guard, for the cases a bundler cannot see through — a dynamic
 *     import, a misconfigured bundler, a runtime that lies about its target.
 *  3. `DeveloperKey` below, which makes the value awkward enough to pass that
 *     nobody does it by accident.
 *
 * In Next.js the caller can add a fourth: `import "server-only"` at the top of
 * whatever wraps this. That breaks the build if a client component ever reaches
 * it, which is better than any check this package can make about itself.
 */

/**
 * A string that has been consciously acknowledged as a developer key.
 *
 * The brand costs one explicit call, and buys a line of code that reads wrong
 * when it is in the wrong place: seeing `asDeveloperKey(...)` in a React
 * component is a louder signal than seeing a bare string.
 */
declare const developerKeyBrand: unique symbol;
export type DeveloperKey = string & { readonly [developerKeyBrand]: true };

export function asDeveloperKey(value: string): DeveloperKey {
  if (!value) throw new Error("the developer key must not be empty");
  // The prefix is checked here and not only by the server so that pasting the
  // wrong secret fails where the mistake was made, with the name of the thing
  // that is wrong, instead of arriving as an anonymous 401.
  if (!value.startsWith("sk_")) throw new Error("a developer key starts with sk_");
  return value as DeveloperKey;
}

/** Thrown when the admin client is constructed somewhere it must never run. */
export class ServerOnlyError extends Error {
  constructor() {
    super(
      "@chasky/botsmith-admin is server-only: it carries a developer key, which " +
        "administers your bots and must never reach a browser. If you need bot " +
        "functionality in the client, that is @chasky/botsmith and a bot token.",
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

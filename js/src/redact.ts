/**
 * Token redaction (G5). Not a logging convenience — a correctness requirement.
 *
 * The token travels in the URL path, so an HTTP client embeds it in its OWN
 * errors: a plain "connection refused" is enough to write the credential into a
 * log. The Error is contaminated before anyone touches it, and the author cannot
 * defend against that because they do not know the error has a URL inside.
 *
 * Everything crossing the SDK boundary goes through here first.
 */

const REDACTED = "<REDACTED>";
/** Catches a token other than the configured one, e.g. after a rotation. */
const BOT_PATH = /\/bot[^/\s]+/g;

export function redactText(text: string, token: string): string {
  const withoutToken = token ? text.split(token).join(REDACTED) : text;
  return withoutToken.replace(BOT_PATH, `/bot${REDACTED}`);
}

/**
 * Returns a NEW error with redacted text. The original is never mutated: it may
 * be shared, and a mutation would be a side effect on someone else's object.
 *
 * `cause` is walked recursively — that is where fetch keeps the real network
 * error, and therefore where the URL usually is.
 */
export function redactError(error: unknown, token: string): Error {
  if (!(error instanceof Error)) {
    return new Error(redactText(String(error), token));
  }
  const clean = new Error(redactText(error.message, token));
  clean.name = error.name;
  if (error.stack) clean.stack = redactText(error.stack, token);
  if (error.cause !== undefined) {
    Object.defineProperty(clean, "cause", {
      value: redactError(error.cause, token),
      configurable: true,
      writable: true,
    });
  }
  return clean;
}

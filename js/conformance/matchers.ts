import type { Failure, Json } from "./types.js";

/**
 * Captured values from $capture:name, shared across every exchange in one case.
 * This is what makes G4 expressible: a fresh Idempotency-Key per logical
 * message, the same one on that message's retry.
 */
export type Captures = Map<string, string>;

const MATCHER = /^\$(any|absent|capture|same|notSame)(?::(.+))?$/;

function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || v === "";
}

/**
 * Matches one value against one expectation. Returns null on success or a
 * reason string on failure.
 *
 * $absent is NOT handled here — absence is a property of the parent object, so
 * matchPartial deals with it before ever reaching a value.
 */
export function matchValue(expected: Json, actual: Json, captures: Captures, path: string): string | null {
  if (typeof expected === "string") {
    const m = MATCHER.exec(expected);
    if (m) {
      const [, kind, name] = m;
      switch (kind) {
        case "any":
          return isEmpty(actual) ? `${path}: expected any non-empty value, got ${fmt(actual)}` : null;
        case "absent":
          return `${path}: $absent is only valid as an object field, not as a value`;
        case "capture": {
          if (isEmpty(actual)) return `${path}: cannot capture an empty value`;
          const prior = captures.get(name!);
          if (prior !== undefined && prior !== String(actual)) {
            return `${path}: ${name} was already captured as ${fmt(prior)}, now saw ${fmt(actual)}`;
          }
          captures.set(name!, String(actual));
          return null;
        }
        case "same": {
          if (!captures.has(name!)) return `${path}: $same:${name} used before ${name} was captured`;
          return String(actual) === captures.get(name!)
            ? null
            : `${path}: expected the captured ${name} (${fmt(captures.get(name!))}), got ${fmt(actual)}`;
        }
        case "notSame": {
          if (!captures.has(name!)) return `${path}: $notSame:${name} used before ${name} was captured`;
          if (isEmpty(actual)) return `${path}: expected a non-empty value differing from ${name}, got ${fmt(actual)}`;
          return String(actual) !== captures.get(name!)
            ? null
            : `${path}: expected a value DIFFERENT from ${name}, but got the same one (${fmt(actual)})`;
        }
      }
    }
  }

  if (expected !== null && typeof expected === "object") {
    if (Array.isArray(expected)) {
      if (!Array.isArray(actual)) return `${path}: expected an array, got ${fmt(actual)}`;
      if (expected.length !== actual.length) {
        return `${path}: expected ${expected.length} elements, got ${actual.length}`;
      }
      for (let i = 0; i < expected.length; i++) {
        const r = matchValue(expected[i]!, actual[i]!, captures, `${path}[${i}]`);
        if (r) return r;
      }
      return null;
    }
    return matchPartial(expected as Record<string, Json>, actual, captures, path);
  }

  return expected === actual ? null : `${path}: expected ${fmt(expected)}, got ${fmt(actual)}`;
}

/**
 * Partial object match: declared fields must match, undeclared fields are
 * ignored. That is deliberate — a case should pin what it is about and stay
 * silent on the rest, so unrelated payload growth does not break every case.
 */
export function matchPartial(
  expected: Record<string, Json>,
  actual: Json,
  captures: Captures,
  path: string,
): string | null {
  if (actual === null || typeof actual !== "object" || Array.isArray(actual)) {
    return `${path}: expected an object, got ${fmt(actual)}`;
  }
  const target = actual as Record<string, Json>;
  for (const [key, exp] of Object.entries(expected)) {
    const at = path ? `${path}.${key}` : key;
    if (exp === "$absent") {
      if (key in target && target[key] !== undefined) {
        return `${at}: expected the field to be absent, but it was ${fmt(target[key])}`;
      }
      continue;
    }
    if (!(key in target)) return `${at}: missing`;
    const r = matchValue(exp, target[key]!, captures, at);
    if (r) return r;
  }
  return null;
}

/** Header names are case-insensitive; values are compared as strings. */
export function matchHeaders(
  expected: Record<string, string>,
  actual: Record<string, string>,
  captures: Captures,
): string | null {
  const lower: Record<string, Json> = {};
  for (const [k, v] of Object.entries(actual)) lower[k.toLowerCase()] = v;
  const wanted: Record<string, Json> = {};
  for (const [k, v] of Object.entries(expected)) wanted[k.toLowerCase()] = v;
  return matchPartial(wanted, lower, captures, "headers");
}

export function fmt(v: unknown): string {
  return typeof v === "string" ? JSON.stringify(v) : String(v);
}

export function failure(where: string, detail: string): Failure {
  return { where, detail };
}

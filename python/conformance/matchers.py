"""Value matching for conformance cases. Mirrors ../../conformance/SCHEMA.md."""

from __future__ import annotations

import json
import re
from typing import Any

Captures = dict[str, str]

_MATCHER = re.compile(r"^\$(any|absent|capture|same|notSame)(?::(.+))?$")


def _is_empty(value: Any) -> bool:
    return value is None or value == ""


def format_value(value: Any) -> str:
    """Render a value the same way regardless of how JSON decoded it.

    A number that arrived as ``float`` must compare equal to the same number
    written as an int in a case.
    """
    if value is None:
        return "null"
    if isinstance(value, str):
        return value
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(int(value)) if float(value).is_integer() else str(value)
    return json.dumps(value, sort_keys=True)


def match_value(expected: Any, actual: Any, captures: Captures, path: str) -> str:
    """Return an empty string on success or a reason on failure.

    ``$absent`` is NOT handled here: absence is a property of the parent
    object, so ``match_partial`` deals with it before reaching a value.
    """
    if isinstance(expected, str):
        matcher = _MATCHER.match(expected)
        if matcher:
            kind, name = matcher.group(1), matcher.group(2)
            if kind == "any":
                return "" if not _is_empty(actual) else (
                    f"{path}: expected any non-empty value, got {format_value(actual)}"
                )
            if kind == "absent":
                return f"{path}: $absent is only valid as an object field, not as a value"
            if kind == "capture":
                if _is_empty(actual):
                    return f"{path}: cannot capture an empty value"
                got = format_value(actual)
                prior = captures.get(name)
                if prior is not None and prior != got:
                    return f"{path}: {name} was already captured as {prior}, now saw {got}"
                captures[name] = got
                return ""
            if kind == "same":
                if name not in captures:
                    return f"{path}: $same:{name} used before {name} was captured"
                if format_value(actual) != captures[name]:
                    return (
                        f"{path}: expected the captured {name} ({captures[name]}), "
                        f"got {format_value(actual)}"
                    )
                return ""
            if kind == "notSame":
                if name not in captures:
                    return f"{path}: $notSame:{name} used before {name} was captured"
                if _is_empty(actual):
                    return (
                        f"{path}: expected a non-empty value differing from {name}, "
                        f"got {format_value(actual)}"
                    )
                if format_value(actual) == captures[name]:
                    return (
                        f"{path}: expected a value DIFFERENT from {name}, but got the "
                        f"same one ({format_value(actual)})"
                    )
                return ""

    if isinstance(expected, dict):
        return match_partial(expected, actual, captures, path)
    if isinstance(expected, list):
        if not isinstance(actual, list):
            return f"{path}: expected an array, got {format_value(actual)}"
        if len(expected) != len(actual):
            return f"{path}: expected {len(expected)} elements, got {len(actual)}"
        for index, item in enumerate(expected):
            reason = match_value(item, actual[index], captures, f"{path}[{index}]")
            if reason:
                return reason
        return ""

    if format_value(expected) != format_value(actual):
        return f"{path}: expected {format_value(expected)}, got {format_value(actual)}"
    return ""


def match_partial(expected: dict[str, Any], actual: Any, captures: Captures, path: str) -> str:
    """Compare only the declared fields, ignoring the rest.

    Deliberate: a case should pin what it is about and stay silent on
    everything else, so unrelated payload growth does not break every case.
    """
    if not isinstance(actual, dict):
        return f"{path}: expected an object, got {format_value(actual)}"
    for key in sorted(expected):
        at = f"{path}.{key}" if path else key
        want = expected[key]
        if want == "$absent":
            # Presence of the KEY is the failure. A decoded JSON null arrives
            # here as None, and treating that as absent would accept the exact
            # mistake m1 exists to catch.
            if key in actual:
                return f"{at}: expected the field to be absent, but it was {format_value(actual[key])}"
            continue
        if key not in actual:
            return f"{at}: missing"
        reason = match_value(want, actual[key], captures, at)
        if reason:
            return reason
    return ""


def match_headers(expected: dict[str, str], actual: dict[str, str], captures: Captures) -> str:
    """Header names are case-insensitive."""
    lowered = {k.lower(): v for k, v in actual.items()}
    wanted = {k.lower(): v for k, v in expected.items()}
    return match_partial(wanted, lowered, captures, "headers")

"""Token redaction (G5).

Not a logging convenience but a correctness requirement: the token travels in
the URL path, so an HTTP client embeds it in its own exceptions. A plain
"connection refused" is enough to write the credential into a log, and the
caller cannot defend against that because they do not know the exception has a
URL inside.

Everything this package raises has been through here.
"""

from __future__ import annotations

import re

REDACTED = "<REDACTED>"

#: Catches a token other than the configured one, e.g. after a rotation.
_BOT_PATH = re.compile(r"/bot[^/\s]+")


def redact_text(text: str, token: str) -> str:
    if token:
        text = text.replace(token, REDACTED)
    return _BOT_PATH.sub(f"/bot{REDACTED}", text)


def redact_exception(error: BaseException, token: str) -> str:
    """Render an exception's message safely, following ``__cause__``.

    The cause chain is walked because that is where an HTTP library keeps the
    real network error, and therefore where the URL usually is. The original
    exception is never mutated: it may be shared, and mutating it would be a
    side effect on someone else's object.
    """
    parts: list[str] = []
    seen: set[int] = set()
    current: BaseException | None = error
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        rendered = str(current) or type(current).__name__
        parts.append(redact_text(rendered, token))
        current = current.__cause__ or current.__context__
    return ": ".join(parts)

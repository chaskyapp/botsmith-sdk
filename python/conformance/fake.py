"""An HTTP server driven by a case's exchange list, on stdlib only."""

from __future__ import annotations

import json
import threading
import time
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

#: How long the fake holds an idle steady-state poll. A real long poll blocks
#: for seconds; answering instantly lets a healthy bot hammer the fake hundreds
#: of times per case and bury a single defect under its own repetition.
STEADY_STATE_POLL = 0.025


@dataclass(slots=True)
class ObservedRequest:
    method: str
    path: str
    headers: dict[str, str]
    body: Any


@dataclass(slots=True)
class _State:
    exchanges: list[dict[str, Any]]
    index: int = 0
    observed: list[ObservedRequest] = field(default_factory=list)
    extras: list[ObservedRequest] = field(default_factory=list)
    lock: threading.Lock = field(default_factory=threading.Lock)


class FakeServer:
    """The exchange list is exhaustive by contract.

    Anything the SDK sends past the last exchange is recorded as an extra and
    fails the case. That is what lets g7-409-stops-and-sends-nothing-more
    assert "not one further request" with no special syntax.
    """

    def __init__(self, exchanges: list[dict[str, Any]]) -> None:
        self._state = _State(exchanges=exchanges)
        state = self._state

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *_args: Any) -> None:
                """Silence: the runner's own output is the report."""

            def _handle(self) -> None:
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length) if length else b""
                try:
                    body = json.loads(raw) if raw else None
                except json.JSONDecodeError:
                    body = raw.decode("utf-8", "replace")
                record = ObservedRequest(
                    method=self.command,
                    path=self.path,
                    headers={k: v for k, v in self.headers.items()},
                    body=body,
                )

                with state.lock:
                    last = state.exchanges[-1] if state.exchanges else {}
                    steady = bool(last.get("repeat")) and state.index >= len(state.exchanges)
                    if steady:
                        exchange = last
                        state.observed.append(record)
                    elif state.index < len(state.exchanges):
                        exchange = state.exchanges[state.index]
                        state.observed.append(record)
                        state.index += 1
                    else:
                        # Beyond the declared list. Recorded, then answered so
                        # the bot does not hang: the case must fail on the
                        # record, not on a timeout, because a timeout hides
                        # WHICH request was unexpected.
                        state.extras.append(record)
                        self._respond(500, {"ok": False, "error_code": 500, "description": "UNEXPECTED_REQUEST"})
                        return

                respond = exchange.get("respond", {})
                delay = respond.get("delayMs", 0) / 1000 or (STEADY_STATE_POLL if steady else 0)
                if delay:
                    time.sleep(delay)

                if respond.get("transportError") is not None:
                    # Kill the connection rather than answer. The HTTP library
                    # is what turns this into an error carrying the full URL —
                    # exactly the G5 scenario the SDK has to redact.
                    self.close_connection = True
                    try:
                        self.connection.close()
                    except OSError:
                        pass
                    return

                self._respond(respond.get("status", 200), respond.get("body"))

            # BaseHTTPRequestHandler dispatches by method name and answers 501 for
            # anything it has no do_* for. With only do_POST defined, every GET
            # in a case came back "Not Implemented" — and nothing caught it for
            # fifteen cases, because the whole runtime suite is POST-only. The
            # first case to read the dialogue found it.
            #
            # The other two fakes take a single handler for every method, so
            # this asymmetry was Python's alone.
            do_POST = _handle  # noqa: N815 - BaseHTTPRequestHandler's contract
            do_GET = _handle  # noqa: N815
            do_PUT = _handle  # noqa: N815
            do_PATCH = _handle  # noqa: N815
            do_DELETE = _handle  # noqa: N815

            def _respond(self, status: int, payload: Any) -> None:
                encoded = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)

        class QuietServer(ThreadingHTTPServer):
            def handle_error(self, request: object, client_address: object) -> None:
                """Swallow the resets this fake causes on purpose.

                g5-transport-error-does-not-leak-the-token works by killing the
                connection, and socketserver answers that with a full traceback
                on stderr. A passing run should be quiet: noise around a green
                result is where a real failure goes to hide.
                """
                import sys
                import traceback

                exc = sys.exc_info()[1]
                if isinstance(exc, (ConnectionResetError, BrokenPipeError)):
                    return
                traceback.print_exc()

        self._server = QuietServer(("127.0.0.1", 0), Handler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()

    @property
    def base_url(self) -> str:
        host, port = self._server.server_address[:2]
        return f"http://{host}:{port}"

    @property
    def exhausted(self) -> bool:
        with self._state.lock:
            return self._state.index >= len(self._state.exchanges)

    @property
    def observed(self) -> list[ObservedRequest]:
        with self._state.lock:
            return list(self._state.observed)

    @property
    def extras(self) -> list[ObservedRequest]:
        with self._state.lock:
            return list(self._state.extras)

    def close(self) -> None:
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=2)

"""Files to send with ``send_document`` (G15)."""

from __future__ import annotations

import asyncio
import json
import os
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import AsyncIterator, Callable, Mapping

#: The server's limit per file (decision A17 of its SDD): 100 MB. A larger file
#: is refused locally, before any request (G15).
MAX_DOCUMENT_BYTES = 100 * 1024 * 1024

_CHUNK = 64 * 1024


@dataclass(frozen=True, slots=True)
class InputFile:
    """A file to send.

    ``open`` is called once per attempt and must yield the file from its start
    every time: a retry sends the whole file again. ``size`` is known before the
    request, so the limit is enforced without sending anything and the body
    goes out with a Content-Length rather than chunked.
    """

    #: Shown to people as the file's name. The type is detected from the bytes.
    file_name: str
    size: int
    open: Callable[[], AsyncIterator[bytes]]

    @classmethod
    def from_path(cls, path: str | os.PathLike[str], file_name: str | None = None) -> "InputFile":
        """A file on disk, streamed from it on every attempt; never read whole.

        The size is taken now. Reads run in a thread so a large file does not
        block the event loop.
        """
        path = Path(path)
        size = path.stat().st_size

        async def chunks() -> AsyncIterator[bytes]:
            handle = await asyncio.to_thread(path.open, "rb")
            try:
                while chunk := await asyncio.to_thread(handle.read, _CHUNK):
                    yield chunk
            finally:
                await asyncio.to_thread(handle.close)

        return cls(file_name=file_name or path.name, size=size, open=chunks)

    @classmethod
    def from_bytes(cls, data: bytes, file_name: str) -> "InputFile":
        """Bytes already in memory."""

        async def chunks() -> AsyncIterator[bytes]:
            yield data

        return cls(file_name=file_name, size=len(data), open=chunks)


def multipart_body(
    fields: Mapping[str, str], document: InputFile
) -> tuple[str, int, Callable[[], AsyncIterator[bytes]]]:
    """A multipart/form-data body, built by hand so its length is known first.

    The text fields and the file's part header are small and go first, the file
    streams after them, and the closing boundary ends it. Returns the content
    type, the exact length and a factory for the body.
    """
    boundary = f"chasky-botsmith-{uuid.uuid4()}"
    head = "".join(
        f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'
        for name, value in fields.items()
    )
    head += (
        f'--{boundary}\r\nContent-Disposition: form-data; name="document"; '
        f'filename="{_quote(document.file_name)}"\r\n'
        "Content-Type: application/octet-stream\r\n\r\n"
    )
    head_bytes = head.encode()
    tail_bytes = f"\r\n--{boundary}--\r\n".encode()

    async def body() -> AsyncIterator[bytes]:
        yield head_bytes
        async for chunk in document.open():
            yield chunk
        yield tail_bytes

    length = len(head_bytes) + document.size + len(tail_bytes)
    return f"multipart/form-data; boundary={boundary}", length, body


def mentions_field(mentions: Mapping[str, str]) -> str:
    return json.dumps(dict(mentions), ensure_ascii=False)


def _quote(name: str) -> str:
    """Escape for a quoted header parameter, as the server's Go parser reads it.

    No line breaks: they would end the header.
    """
    name = name.replace("\r", " ").replace("\n", " ")
    return name.replace("\\", "\\\\").replace('"', '\\"')

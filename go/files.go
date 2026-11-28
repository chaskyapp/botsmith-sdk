package chaskybot

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// MaxDocumentBytes is the server's limit per file (decision A17 of its SDD):
// 100 MB. A larger file is refused locally, before any request (G15).
const MaxDocumentBytes int64 = 100 << 20

// InputFile is a file to send with SendDocument.
//
// Open is called once per attempt and must return the file from its start
// every time: a retry sends the whole file again (G15). Size is known before
// the request, so the limit is enforced without sending anything and the body
// goes out with a Content-Length rather than chunked.
type InputFile struct {
	// Name is shown to people as the file's name. The type is detected from
	// the bytes, not from it.
	Name string
	Size int64
	Open func() (io.ReadCloser, error)
}

// FileFromPath streams a file on disk, reopening it on every attempt; it is
// never read whole. The size is taken now.
func FileFromPath(path string) (InputFile, error) {
	info, err := os.Stat(path)
	if err != nil {
		return InputFile{}, err
	}
	if !info.Mode().IsRegular() {
		return InputFile{}, &UsageError{Message: fmt.Sprintf("%s is not a regular file", path)}
	}
	return InputFile{
		Name: filepath.Base(path),
		Size: info.Size(),
		Open: func() (io.ReadCloser, error) { return os.Open(path) },
	}, nil
}

// FileFromBytes sends bytes already in memory.
func FileFromBytes(name string, data []byte) InputFile {
	return InputFile{
		Name: name,
		Size: int64(len(data)),
		Open: func() (io.ReadCloser, error) { return io.NopCloser(bytes.NewReader(data)), nil },
	}
}

// SendDocumentParams are sendDocument's fields; Document is streamed.
type SendDocumentParams struct {
	ChatID   ChatID
	Document InputFile
	// Caption is up to 1024 characters.
	Caption          string
	ReplyToMessageID MessageID
	// Mentions name people as they appear in Caption, as in SendMessage.
	Mentions map[string]UserID
	// IdempotencyKey is managed by the runtime; see G4.
	IdempotencyKey string
}

// SendDocument sends a file, streamed as multipart with its length (G15).
//
// A file over 100 MB, or empty, is refused here without a request. The
// transfer is bounded by ctx, not by the client's overall timeout, which is
// sized for a poll and would cut a large upload. Each call opens Document once,
// so a retry with the same IdempotencyKey sends the whole file again.
func (c *Client) SendDocument(ctx context.Context, p SendDocumentParams) (*Message, error) {
	doc := p.Document
	if doc.Open == nil {
		return nil, &UsageError{Message: "sendDocument requires a Document with Open"}
	}
	if doc.Size > MaxDocumentBytes {
		return nil, &UsageError{Message: fmt.Sprintf(
			"FILE_TOO_LARGE: %s is %d bytes; the limit is %d (100 MB)", doc.Name, doc.Size, MaxDocumentBytes)}
	}
	if doc.Size <= 0 {
		return nil, &UsageError{Message: fmt.Sprintf("FILE_REQUIRED: %s is empty", doc.Name)}
	}

	fields := [][2]string{{"chat_id", p.ChatID}}
	if p.Caption != "" {
		fields = append(fields, [2]string{"caption", p.Caption})
	}
	if p.ReplyToMessageID != "" {
		fields = append(fields, [2]string{"reply_to_message_id", p.ReplyToMessageID})
	}
	// Only when there is something to send, as in SendMessage (G12).
	if len(p.Mentions) > 0 {
		encoded, err := json.Marshal(p.Mentions)
		if err != nil {
			return nil, &UsageError{Message: fmt.Sprintf("sendDocument: could not encode mentions: %s", err)}
		}
		fields = append(fields, [2]string{"mentions", string(encoded)})
	}

	file, err := doc.Open()
	if err != nil {
		return nil, &UsageError{Message: fmt.Sprintf("sendDocument: could not open %s: %s", doc.Name, err)}
	}
	defer file.Close()

	boundary, err := newIdempotencyKey()
	if err != nil {
		return nil, err
	}
	boundary = "chasky-botsmith-" + boundary
	var head strings.Builder
	for _, f := range fields {
		fmt.Fprintf(&head, "--%s\r\nContent-Disposition: form-data; name=%q\r\n\r\n%s\r\n", boundary, f[0], f[1])
	}
	fmt.Fprintf(&head, "--%s\r\nContent-Disposition: form-data; name=\"document\"; filename=\"%s\"\r\n"+
		"Content-Type: application/octet-stream\r\n\r\n", boundary, quoteFileName(doc.Name))
	tail := "\r\n--" + boundary + "--\r\n"

	body := io.MultiReader(strings.NewReader(head.String()), io.LimitReader(file, doc.Size), strings.NewReader(tail))
	length := int64(head.Len()) + doc.Size + int64(len(tail))

	headers := map[string]string{}
	if p.IdempotencyKey != "" {
		headers["Idempotency-Key"] = p.IdempotencyKey
	}
	var raw wireMessage
	err = c.send(ctx, c.transfer, "sendDocument", body, length, "multipart/form-data; boundary="+boundary, headers, &raw)
	if err != nil {
		return nil, err
	}
	return raw.toMessage(), nil
}

// quoteFileName escapes a filename for a quoted header parameter the way the
// server's parser (Go's mime package) reads it, with no line breaks, which
// would end the header.
var quoteFileName = strings.NewReplacer("\\", "\\\\", `"`, `\"`, "\r", " ", "\n", " ").Replace

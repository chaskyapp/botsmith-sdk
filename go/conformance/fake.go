package conformance

import (
	"bytes"
	"encoding/json"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"time"
)

// How long the fake holds an idle steady-state poll. A real long poll blocks
// for seconds; answering instantly lets a healthy bot hammer the fake hundreds
// of times per case and bury a single defect under its own repetition.
const steadyStatePoll = 25 * time.Millisecond

// FakeServer replays a case's exchange list.
//
// The list is exhaustive by contract: anything sent past the last exchange is
// recorded as an extra and fails the case. That is what lets
// g7-409-stops-and-sends-nothing-more assert "not one further request" with no
// special syntax.
type FakeServer struct {
	exchanges []Exchange
	server    *httptest.Server

	mu       sync.Mutex
	index    int
	observed []ObservedRequest
	extras   []ObservedRequest
}

func NewFakeServer(exchanges []Exchange) *FakeServer {
	f := &FakeServer{exchanges: exchanges}
	f.server = httptest.NewServer(http.HandlerFunc(f.handle))
	return f
}

func (f *FakeServer) BaseURL() string { return f.server.URL }

func (f *FakeServer) Close() { f.server.Close() }

func (f *FakeServer) Exhausted() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.index >= len(f.exchanges)
}

func (f *FakeServer) Observed() []ObservedRequest {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]ObservedRequest{}, f.observed...)
}

func (f *FakeServer) Extras() []ObservedRequest {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]ObservedRequest{}, f.extras...)
}

func (f *FakeServer) handle(w http.ResponseWriter, r *http.Request) {
	raw, _ := io.ReadAll(r.Body)
	receivedAt := time.Now()
	headers := map[string]string{}
	for name := range r.Header {
		headers[name] = r.Header.Get(name)
	}
	// net/http moves these out of Header; put them back so a case can see them.
	if len(r.TransferEncoding) > 0 {
		headers["Transfer-Encoding"] = strings.Join(r.TransferEncoding, ", ")
	}
	var body any
	if media, params, err := mime.ParseMediaType(r.Header.Get("Content-Type")); err == nil && media == "multipart/form-data" {
		body = parseMultipart(raw, params["boundary"])
	} else if len(raw) > 0 {
		if err := json.Unmarshal(raw, &body); err != nil {
			body = string(raw)
		}
	}
	// RequestURI, not Path: the runner splits the query off itself, and with
	// Path alone expect.query had nothing to match against.
	record := ObservedRequest{Method: r.Method, Path: r.URL.RequestURI(), Headers: headers, Body: body, ReceivedAt: receivedAt}

	f.mu.Lock()
	last := Exchange{}
	if len(f.exchanges) > 0 {
		last = f.exchanges[len(f.exchanges)-1]
	}
	steadyState := last.Repeat && f.index >= len(f.exchanges)

	var exchange Exchange
	switch {
	case steadyState:
		exchange = last
		f.observed = append(f.observed, record)
	case f.index < len(f.exchanges):
		exchange = f.exchanges[f.index]
		f.observed = append(f.observed, record)
		f.index++
	default:
		// Beyond the declared list. Recorded, then answered so the bot does not
		// hang: the case must fail on the record, not on a timeout, because a
		// timeout hides WHICH request was unexpected.
		f.extras = append(f.extras, record)
		f.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error_code": 500, "description": "UNEXPECTED_REQUEST"})
		return
	}
	f.mu.Unlock()

	delay := time.Duration(exchange.Respond.DelayMs) * time.Millisecond
	if delay == 0 && steadyState {
		delay = steadyStatePoll
	}
	if delay > 0 {
		time.Sleep(delay)
	}

	if exchange.Respond.TransportError != "" {
		// Kill the connection rather than answer. net/http is what turns this
		// into an error carrying the full URL — exactly the G5 scenario the SDK
		// has to redact.
		if hijacker, ok := w.(http.Hijacker); ok {
			if conn, _, err := hijacker.Hijack(); err == nil {
				_ = conn.Close()
				return
			}
		}
		panic(http.ErrAbortHandler) // closes the connection without a response
	}

	status := exchange.Respond.Status
	if status == 0 {
		status = http.StatusOK
	}
	if raw := exchange.Respond.RawBody; raw != nil {
		w.Header().Set("Content-Type", "application/octet-stream")
		w.WriteHeader(status)
		_, _ = io.WriteString(w, *raw)
		return
	}
	encoded, _ := json.Marshal(exchange.Respond.Body)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	// {baseUrl} lets a case hand the SDK a URL back to this fake (G14).
	_, _ = w.Write(bytes.ReplaceAll(encoded, []byte("{baseUrl}"), []byte(f.server.URL)))
}

// parseMultipart turns a multipart body into an object: text fields as
// strings, file parts as {fileName, size} (SCHEMA.md). Anything malformed
// comes back as the raw text, so the case fails on the field it expected.
func parseMultipart(raw []byte, boundary string) any {
	out := map[string]any{}
	reader := multipart.NewReader(bytes.NewReader(raw), boundary)
	for {
		part, err := reader.NextPart()
		if err == io.EOF {
			return out
		}
		if err != nil {
			return string(raw)
		}
		data, err := io.ReadAll(part)
		if err != nil {
			return string(raw)
		}
		if part.FileName() != "" {
			out[part.FormName()] = map[string]any{"fileName": part.FileName(), "size": float64(len(data))}
		} else {
			out[part.FormName()] = string(data)
		}
	}
}

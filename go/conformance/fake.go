package conformance

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
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
	headers := map[string]string{}
	for name := range r.Header {
		headers[name] = r.Header.Get(name)
	}
	var body any
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &body); err != nil {
			body = string(raw)
		}
	}
	record := ObservedRequest{Method: r.Method, Path: r.URL.Path, Headers: headers, Body: body}

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
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(exchange.Respond.Body)
}

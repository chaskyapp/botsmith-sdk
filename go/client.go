package chaskybot

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Server maximums, hardcoded because the server does not publish them yet
// (request S3 in §13). When it does, these become the fallback.
const (
	MaxLimit          = 100
	MaxTimeoutSeconds = 30
)

const DefaultBaseURL = "https://api.chasky.io/api/v1"

type Options struct {
	Token   string
	BaseURL string
	// HTTPClient is optional. Its timeout must exceed the longest poll; leave
	// it nil to get one that does.
	HTTPClient *http.Client
	OnWarning  func(message string)
	// AllowInsecureTransport opts out of the plaintext warning (D8).
	AllowInsecureTransport bool
}

// Client is a 1:1 wrapper over the four methods. No loop, no state beyond
// configuration; safe for concurrent use.
type Client struct {
	token   string
	baseURL string
	http    *http.Client
	warn    func(string)
}

func NewClient(opts Options) (*Client, error) {
	if opts.Token == "" {
		return nil, &UsageError{Message: "a bot token is required"}
	}
	warn := opts.OnWarning
	if warn == nil {
		warn = func(string) {}
	}
	base := strings.TrimRight(opts.BaseURL, "/")
	if base == "" {
		base = DefaultBaseURL
	}
	httpClient := opts.HTTPClient
	if httpClient == nil {
		// Room for the longest poll plus latency. Cancellation is the context's
		// job, not this timeout's.
		httpClient = &http.Client{Timeout: (MaxTimeoutSeconds + 15) * time.Second}
	}

	c := &Client{token: opts.Token, baseURL: base, http: httpClient, warn: warn}

	// D8: warn ONCE, at construction. A warning per poll is noise that ends up
	// filtered out of a grep, which is the same as no warning at all.
	if !opts.AllowInsecureTransport && isInsecure(base) {
		c.warn("baseURL uses plaintext http:// to a non-loopback host. The bot token travels in the " +
			"URL PATH, so every proxy on the way writes it down. Use https://, or set " +
			"AllowInsecureTransport to accept this.")
	}
	return c, nil
}

func (c *Client) GetMe(ctx context.Context) (Identity, error) {
	var raw wireIdentity
	if err := c.call(ctx, "getMe", struct{}{}, nil, &raw); err != nil {
		return Identity{}, err
	}
	display := raw.DisplayName
	if display == "" {
		display = raw.FirstName
	}
	return Identity{ID: raw.ID, IsBot: true, Username: raw.Username, DisplayName: display}, nil
}

type GetUpdatesParams struct {
	Offset         int64
	Limit          int
	TimeoutSeconds int
}

func (c *Client) GetUpdates(ctx context.Context, p GetUpdatesParams) ([]Update, error) {
	limit, err := c.clampLimit(p.Limit)
	if err != nil {
		return nil, err
	}
	timeout, err := c.clampTimeout(p.TimeoutSeconds)
	if err != nil {
		return nil, err
	}
	body := map[string]any{"offset": p.Offset, "limit": limit, "timeout": timeout}

	var raw []wireUpdate
	if err := c.call(ctx, "getUpdates", body, nil, &raw); err != nil {
		return nil, err
	}
	// A missing or malformed result is an empty batch, never a panic: the poll
	// loop must survive a server that answers something unexpected.
	updates := make([]Update, 0, len(raw))
	for _, u := range raw {
		updates = append(updates, Update{ID: u.UpdateID, Message: u.Message.toMessage()})
	}
	return updates, nil
}

type SendMessageParams struct {
	ChatID           ChatID
	Text             string
	ReplyToMessageID MessageID
	// IdempotencyKey is managed by the runtime: one per logical message, the
	// same one on every retry of THAT message. See G4.
	IdempotencyKey string
}

func (c *Client) SendMessage(ctx context.Context, p SendMessageParams) (*Message, error) {
	if p.Text == "" {
		return nil, &UsageError{Message: "sendMessage requires a non-empty text"}
	}
	body := map[string]any{"chat_id": p.ChatID, "text": p.Text}
	if p.ReplyToMessageID != "" {
		body["reply_to_message_id"] = p.ReplyToMessageID
	}
	var headers map[string]string
	if p.IdempotencyKey != "" {
		headers = map[string]string{"Idempotency-Key": p.IdempotencyKey}
	}

	var raw wireMessage
	if err := c.call(ctx, "sendMessage", body, headers, &raw); err != nil {
		return nil, err
	}
	return raw.toMessage(), nil
}

func (c *Client) SendChatAction(ctx context.Context, chatID ChatID, action ChatAction) error {
	var ok bool
	return c.call(ctx, "sendChatAction", map[string]any{"chat_id": chatID, "action": action}, nil, &ok)
}

func (c *Client) clampLimit(limit int) (int, error) {
	if limit == 0 {
		return MaxLimit, nil
	}
	if limit < 1 {
		// The server answers 400 to these. Rejecting locally, with the reason,
		// beats spending a request to be told the same thing less clearly.
		return 0, &UsageError{Message: fmt.Sprintf("limit must be at least 1, got %d", limit)}
	}
	if limit > MaxLimit {
		c.warn(fmt.Sprintf("limit %d clamped to the server maximum of %d", limit, MaxLimit))
		return MaxLimit, nil
	}
	return limit, nil
}

func (c *Client) clampTimeout(seconds int) (int, error) {
	if seconds < 0 {
		return 0, &UsageError{Message: fmt.Sprintf("timeoutSeconds must not be negative, got %d", seconds)}
	}
	if seconds > MaxTimeoutSeconds {
		c.warn(fmt.Sprintf("timeoutSeconds %d clamped to the server maximum of %d", seconds, MaxTimeoutSeconds))
		return MaxTimeoutSeconds, nil
	}
	return seconds, nil
}

func (c *Client) call(ctx context.Context, method string, body any, headers map[string]string, out any) error {
	payload, err := json.Marshal(body)
	if err != nil {
		return &UsageError{Message: fmt.Sprintf("%s: could not encode the request: %s", method, err)}
	}
	endpoint := c.baseURL + "/bot" + c.token + "/" + method

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return &TransportError{Method: method, cause: redactError(err, c.token)}
	}
	req.Header.Set("Content-Type", "application/json")
	for k, v := range headers {
		req.Header.Set(k, v)
	}

	resp, err := c.http.Do(req)
	if err != nil {
		// The URL is in here. Redact before it can reach a log.
		return &TransportError{Method: method, cause: redactError(err, c.token)}
	}
	defer resp.Body.Close()

	var envelope struct {
		OK          bool            `json:"ok"`
		Result      json.RawMessage `json:"result"`
		ErrorCode   int             `json:"error_code"`
		Description string          `json:"description"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&envelope); err != nil {
		return &TransportError{
			Method: method,
			cause:  redactError(fmt.Errorf("body was not JSON (HTTP %d): %w", resp.StatusCode, err), c.token),
		}
	}
	if !envelope.OK {
		code := envelope.ErrorCode
		if code == 0 {
			code = resp.StatusCode
		}
		description := envelope.Description
		if description == "" {
			description = "UNKNOWN"
		}
		return &APIError{Code: code, Description: description, Method: method}
	}
	if out == nil || len(envelope.Result) == 0 {
		return nil
	}
	if err := json.Unmarshal(envelope.Result, out); err != nil {
		return &TransportError{
			Method: method,
			cause:  redactError(fmt.Errorf("result did not match the expected shape: %w", err), c.token),
		}
	}
	return nil
}

// isInsecure reports plaintext to a non-loopback host. Loopback only, and
// deliberately not *.local: mDNS can resolve to a real machine on the network.
func isInsecure(baseURL string) bool {
	u, err := url.Parse(baseURL)
	if err != nil || u.Scheme != "http" {
		return false
	}
	host := strings.ToLower(u.Hostname())
	if host == "localhost" || host == "::1" || strings.HasSuffix(host, ".localhost") {
		return false
	}
	if ip := net.ParseIP(host); ip != nil && ip.IsLoopback() {
		return false
	}
	return true
}

package admin

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// PlatformSecret is the platform's own API secret, deliberately not a string.
//
// A leaked bot token lets someone post as that one bot: bad, bounded, closed by
// rotating it. This opens every non-public route on the API. They are not the
// same incident, and the type keeps them from being passed to the same places.
type PlatformSecret string

// AsPlatformSecret acknowledges a value as the platform secret.
func AsPlatformSecret(value string) PlatformSecret { return PlatformSecret(value) }

type Options struct {
	BaseURL string
	// BearerToken is a human session token. The server accepts a bearer OR a
	// cookie, never both: if an Authorization header is present it must be
	// exactly one header with exactly two fields, and the cookie is only
	// consulted when it is absent.
	BearerToken string
	// APISecret goes in X-Secret. It is a PLATFORM secret and must never reach
	// a browser or a bot process.
	//
	// Its own named type is the point: Go will not accept a bare string here, so
	// passing it takes an explicit AsPlatformSecret(...) — a line that reads
	// wrong wherever it does not belong. Go has no browser to guard against, so
	// this is the layer that does the work.
	APISecret  PlatformSecret
	HTTPClient *http.Client
	// NewOperationID supplies operation ids; override for deterministic tests.
	NewOperationID func() string
}

type Client struct {
	baseURL        string
	bearerToken    string
	apiSecret      PlatformSecret
	http           *http.Client
	newOperationID func() string
}

func New(opts Options) (*Client, error) {
	if opts.APISecret == "" {
		return nil, fmt.Errorf("admin: an API secret is required")
	}
	httpClient := opts.HTTPClient
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 30 * time.Second}
	}
	newID := opts.NewOperationID
	if newID == nil {
		newID = uuidV4
	}
	return &Client{
		baseURL:        strings.TrimRight(opts.BaseURL, "/"),
		bearerToken:    opts.BearerToken,
		apiSecret:      opts.APISecret,
		http:           httpClient,
		newOperationID: newID,
	}, nil
}

// Page bounds a listing. Only cursor and limit exist; the server rejects any
// other query key outright.
type Page struct {
	Cursor string
	Limit  int
}

func (c *Client) Capability(ctx context.Context) (Capability, error) {
	var out Capability
	err := c.do(ctx, http.MethodGet, "/capability", nil, Page{}, &out)
	return out, err
}

func (c *Client) Bots(ctx context.Context, page Page) (BotPage, error) {
	var out BotPage
	err := c.do(ctx, http.MethodGet, "/bots", nil, page, &out)
	return out, err
}

func (c *Client) Bot(ctx context.Context, id string) (BotView, error) {
	var out BotView
	err := c.do(ctx, http.MethodGet, "/bots/"+url.PathEscape(id), nil, Page{}, &out)
	return out, err
}

func (c *Client) Dialogue(ctx context.Context, page Page) (DialoguePage, error) {
	var out DialoguePage
	err := c.do(ctx, http.MethodGet, "/dialogue", nil, page, &out)
	return out, err
}

type CommandParams struct {
	Command          CommandKind
	ExpectedRevision int64
	// Value, BotID and ExpectedCredentialVersion are optional. Their zero
	// values mean "omit": the server rejects a null even where the field is
	// optional, so a pointer or an empty string is never serialised as one.
	Value                     string
	BotID                     string
	ExpectedCredentialVersion *int64
	// OperationID is reused verbatim on a retry, exactly like the runtime's
	// Idempotency-Key. Leave empty to have one generated.
	OperationID string
}

func (c *Client) Command(ctx context.Context, p CommandParams) (CommandResult, error) {
	operationID := p.OperationID
	if operationID == "" {
		operationID = c.newOperationID()
	}
	// Built field by field, and ONLY when set. A struct with omitempty would
	// almost work, but "omit" here is the contract rather than a preference, so
	// it is done explicitly where it can be read.
	body := map[string]any{
		"operationID":      operationID,
		"expectedRevision": p.ExpectedRevision,
		"command":          string(p.Command),
	}
	if p.Value != "" {
		body["value"] = p.Value
	}
	if p.BotID != "" {
		body["botID"] = p.BotID
	}
	if p.ExpectedCredentialVersion != nil {
		body["expectedCredentialVersion"] = *p.ExpectedCredentialVersion
	}

	var out CommandResult
	err := c.do(ctx, http.MethodPost, "/commands", body, Page{}, &out)
	return out, err
}

type GrantParams struct {
	Enabled          bool
	ExpectedRevision int64
	OperationID      string
}

func (c *Client) Grant(ctx context.Context, targetID string, p GrantParams) (GrantView, error) {
	operationID := p.OperationID
	if operationID == "" {
		operationID = c.newOperationID()
	}
	body := map[string]any{
		"operationID":      operationID,
		"expectedRevision": p.ExpectedRevision,
		"enabled":          p.Enabled,
	}
	var out GrantView
	err := c.do(ctx, http.MethodPut, "/administrators/"+url.PathEscape(targetID), body, Page{}, &out)
	return out, err
}

func (c *Client) do(ctx context.Context, method, path string, body any, page Page, out any) error {
	target := c.baseURL + "/bot-management" + path
	if query := page.encode(); query != "" {
		target += "?" + query
	}
	label := method + " " + path

	var reader *bytes.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return &TransportError{Method: label, cause: err}
		}
		reader = bytes.NewReader(encoded)
	} else {
		reader = bytes.NewReader(nil)
	}

	req, err := http.NewRequestWithContext(ctx, method, target, reader)
	if err != nil {
		return &TransportError{Method: label, cause: err}
	}
	req.Header.Set("X-Secret", string(c.apiSecret))
	if c.bearerToken != "" {
		req.Header.Set("Authorization", "Bearer "+c.bearerToken)
	}
	if body != nil {
		// Exactly this, with no charset: the server parses the media type and
		// rejects anything that is not application/json.
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return &TransportError{Method: label, cause: err}
	}
	defer resp.Body.Close()

	var envelope struct {
		OK    bool            `json:"ok"`
		Data  json.RawMessage `json:"data"`
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&envelope); err != nil {
		return &TransportError{Method: label, cause: fmt.Errorf("body was not JSON (HTTP %d): %w", resp.StatusCode, err)}
	}
	if !envelope.OK {
		return &Error{Code: codeFor(envelope.Error.Code, resp.StatusCode), Status: resp.StatusCode, Method: label}
	}
	if out == nil || len(envelope.Data) == 0 {
		return nil
	}
	if err := json.Unmarshal(envelope.Data, out); err != nil {
		return &TransportError{Method: label, cause: fmt.Errorf("data did not match the expected shape: %w", err)}
	}
	return nil
}

func (p Page) encode() string {
	values := url.Values{}
	if p.Cursor != "" {
		values.Set("cursor", p.Cursor)
	}
	if p.Limit > 0 {
		values.Set("limit", strconv.Itoa(p.Limit))
	}
	return values.Encode()
}

func uuidV4() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return ""
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	s := hex.EncodeToString(b[:])
	return s[:8] + "-" + s[8:12] + "-" + s[12:16] + "-" + s[16:20] + "-" + s[20:]
}

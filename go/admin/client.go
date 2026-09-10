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

// DeveloperKey is a developer's own administration credential, deliberately
// not a string.
//
// A leaked bot token lets someone post as that one bot. A leaked key lets them
// administer every bot you own: create them, rotate their tokens, point their
// webhooks at their own server. They are not the same incident, and the type
// keeps them from being passed to the same places.
type DeveloperKey string

// AsDeveloperKey acknowledges a value as a developer key.
//
// The prefix is checked here and not only by the server so that pasting the
// wrong secret fails where the mistake was made, naming what is wrong, instead
// of arriving as an anonymous 401 on the first call.
func AsDeveloperKey(value string) (DeveloperKey, error) {
	if !strings.HasPrefix(value, "sk_") {
		return "", fmt.Errorf("admin: a developer key starts with sk_")
	}
	return DeveloperKey(value), nil
}

// Options carries EXACTLY ONE credential: a developer key or a session bearer.
//
// Not zero, not both. The server rejects a request carrying two credentials
// instead of picking one, because picking by precedence hides a
// misconfiguration; New mirrors that rule so the mistake surfaces where it was
// made rather than as an anonymous 401 on the first call.
// developerKeyHeader is the header a key travels in. Never Authorization:
// sharing that header with the session would make "brought two credentials"
// indistinguishable from "brought one".
const developerKeyHeader = "X-Chasky-Dev-Secret"

type Options struct {
	BaseURL string
	// DeveloperKey administers the bots of whoever issued it. Its own named
	// type is the point: Go will not accept a bare string here, so passing it
	// takes an explicit AsDeveloperKey(...) — a line that reads wrong wherever
	// it does not belong.
	DeveloperKey DeveloperKey
	// BearerToken is a human session token — how the portal's own backend calls
	// this surface.
	BearerToken string
	HTTPClient  *http.Client
	// NewOperationID supplies operation ids; override for deterministic tests.
	NewOperationID func() string
}

type Client struct {
	baseURL        string
	bearerToken    string
	developerKey   DeveloperKey
	http           *http.Client
	newOperationID func() string
}

func New(opts Options) (*Client, error) {
	if opts.DeveloperKey != "" && opts.BearerToken != "" {
		return nil, fmt.Errorf("admin: pass a developer key or a bearer token, not both: the server rejects a request carrying two credentials rather than choosing between them")
	}
	if opts.DeveloperKey == "" && opts.BearerToken == "" {
		return nil, fmt.Errorf("admin: a developer key or a bearer token is required")
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
		developerKey:   opts.DeveloperKey,
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
	// ONE credential leaves this client, never two. The server treats a key next
	// to a session as a misconfiguration and answers 401 instead of choosing, so
	// sending both would turn a working key into a mystery.
	if c.developerKey != "" {
		req.Header.Set(developerKeyHeader, string(c.developerKey))
	} else {
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

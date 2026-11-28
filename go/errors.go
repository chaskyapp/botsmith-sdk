package chaskybot

import (
	"errors"
	"fmt"
	"time"
)

// APIError is a failure the server described in its envelope.
type APIError struct {
	// Code is the flow control. Never branch on Description: the server
	// declares it readable and stable, but not enumerated.
	Code        int
	Description string
	Method      string
	// RetryAfter is how long the server asked us to wait (G11). Zero when the
	// envelope carried no usable parameters.retry_after.
	RetryAfter time.Duration
}

func (e *APIError) Error() string {
	return fmt.Sprintf("%s failed: %d %s", e.Method, e.Code, e.Description)
}

// TransportError means the request never produced an envelope: network, DNS,
// cancellation, or a body that was not JSON. Its message is already redacted;
// Unwrap still reaches the original so errors.Is(err, context.Canceled) works.
type TransportError struct {
	Method string
	cause  error
}

func (e *TransportError) Error() string {
	return fmt.Sprintf("%s could not reach the server: %s", e.Method, e.cause)
}
func (e *TransportError) Unwrap() error { return e.cause }

// DownloadError means downloading an attachment answered something other
// than 2xx. It is not an APIError: the media store has no envelope. A 403 or
// 404 usually means the URL expired, and it cannot be renewed: there is no
// getFile (G14).
type DownloadError struct {
	// Status is the HTTP status the media store answered.
	Status int
	// URL is the attachment's URL without its query, which may hold a
	// signature.
	URL string
}

func (e *DownloadError) Error() string {
	return fmt.Sprintf("download of %s failed: HTTP %d", e.URL, e.Status)
}

// UsageError is raised locally, before spending a request.
type UsageError struct{ Message string }

func (e *UsageError) Error() string { return e.Message }

type errorClass int

const (
	classTransient errorClass = iota
	classTerminal
	classBusiness
)

type errorSource int

const (
	sourcePoll errorSource = iota
	sourceCall
)

// classify decides what the SDK does with a failure (§10.2, G7).
//
// Classification reads the code and WHICH CALL produced it, never the
// description. A 403 while polling means this bot is barred from polling at all
// and is terminal; a 403 from a send means that one chat is not ours and the
// bot lives on. Reading the method is both correct and immune to a description
// the server never promised to keep enumerated.
func classify(err error, source errorSource) errorClass {
	var api *APIError
	if errors.As(err, &api) {
		switch {
		// A 429 is "not yet", from any source: never terminal, never dropped (G11).
		case api.Code >= 500 || api.Code == 429:
			return classTransient
		case source == sourcePoll && (api.Code == 401 || api.Code == 403 || api.Code == 409):
			return classTerminal
		case source == sourceCall && api.Code == 401:
			return classTerminal
		default:
			return classBusiness
		}
	}
	var usage *UsageError
	if errors.As(err, &usage) {
		return classBusiness
	}
	return classTransient
}

// retryDelay is the backoff, or what the server asked for in a 429 if that is
// longer. Waiting less only earns another 429 (G11).
func retryDelay(err error, backoff time.Duration) time.Duration {
	var api *APIError
	if errors.As(err, &api) && api.RetryAfter > backoff {
		return api.RetryAfter
	}
	return backoff
}

// Descriptions the server documents for group sends. They are for logs and for
// the author's own branching; the SDK itself never reads a description, because
// flow control is the Code (§10.1).
const (
	DescBotNotAMember     = "BOT_NOT_A_MEMBER"
	DescMentionNotAMember = "MENTION_NOT_A_MEMBER"
	DescTooManyMentions   = "TOO_MANY_MENTIONS"
	DescTooManyRequests   = "TOO_MANY_REQUESTS"
)

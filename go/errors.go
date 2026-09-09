package chaskybot

import (
	"errors"
	"fmt"
)

// APIError is a failure the server described in its envelope.
type APIError struct {
	// Code is the flow control. Never branch on Description: the server
	// declares it readable and stable, but not enumerated.
	Code        int
	Description string
	Method      string
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
		case api.Code >= 500:
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

package chaskybot

import (
	"regexp"
	"strings"
)

// Token redaction (G5). Not a logging convenience but a correctness
// requirement: the token travels in the URL path, so net/http embeds it in its
// own errors. A plain "connection refused" is enough to write the credential
// into a log, and the caller cannot defend against that because they do not
// know the error has a URL inside.
//
// Everything this package returns has been through here.

const redacted = "<REDACTED>"

// Catches a token other than the configured one, e.g. after a rotation.
var botPath = regexp.MustCompile(`/bot[^/\s]+`)

func redactText(text, token string) string {
	if token != "" {
		text = strings.ReplaceAll(text, token, redacted)
	}
	return botPath.ReplaceAllString(text, "/bot"+redacted)
}

// redactedError wraps an error so that its message is safe while the original
// stays reachable through errors.Is and errors.As. Unwrapping deliberately
// keeps working: callers must still be able to test for context.Canceled.
type redactedError struct {
	msg   string
	cause error
}

func (e *redactedError) Error() string { return e.msg }
func (e *redactedError) Unwrap() error { return e.cause }

func redactError(err error, token string) error {
	if err == nil {
		return nil
	}
	return &redactedError{msg: redactText(err.Error(), token), cause: err}
}

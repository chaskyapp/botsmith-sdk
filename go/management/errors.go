package management

import "fmt"

// Code is the envelope's string code. Unlike the runtime, where the code is a
// number, this surface reports strings.
type Code string

const (
	CodeInvalidInput     Code = "INVALID_INPUT"
	CodeUnauthorized     Code = "UNAUTHORIZED"
	CodeForbidden        Code = "FORBIDDEN"
	CodeNotFound         Code = "NOT_FOUND"
	CodeStaleState       Code = "STALE_STATE"
	CodeQuotaExceeded    Code = "QUOTA_EXCEEDED"
	CodeTooManyAttempts  Code = "TOO_MANY_ATTEMPTS"
	CodeUnavailable      Code = "UNAVAILABLE"
	CodeRecoveryRequired Code = "RECOVERY_REQUIRED"
	CodeUnknown          Code = "UNKNOWN"
)

type Error struct {
	Code   Code
	Status int
	Method string
}

func (e *Error) Error() string { return fmt.Sprintf("%s failed: %s", e.Method, e.Code) }

// Retryable reports whether re-reading the current revision and sending again
// is the right move.
//
// STALE_STATE is the point of the dialogue's optimistic concurrency: someone
// advanced it, so read Dialogue again and resend with the revision just seen.
func (e *Error) Retryable() bool {
	return e.Code == CodeStaleState || e.Code == CodeUnavailable
}

// AccessLost reports whether administration is actually gone.
//
// QUOTA_EXCEEDED and TOO_MANY_ATTEMPTS are deliberately NOT FORBIDDEN on the
// server. Its own comment explains why: a caller treats 403 as "your
// administration was revoked" and tears the session down, while a quota reached
// is normal and recoverable. Reporting either as lost access lies about what
// happened.
func (e *Error) AccessLost() bool {
	return e.Code == CodeUnauthorized || e.Code == CodeForbidden
}

// TransportError means the request never produced an envelope.
type TransportError struct {
	Method string
	cause  error
}

func (e *TransportError) Error() string {
	return fmt.Sprintf("%s could not reach the server: %s", e.Method, e.cause)
}
func (e *TransportError) Unwrap() error { return e.cause }

var statusToCode = map[int]Code{
	400: CodeInvalidInput,
	401: CodeUnauthorized,
	403: CodeForbidden,
	404: CodeNotFound,
	409: CodeStaleState,
	422: CodeQuotaExceeded,
	429: CodeTooManyAttempts,
	503: CodeUnavailable,
}

// codeFor prefers the envelope's code and falls back to the status.
func codeFor(envelopeCode string, status int) Code {
	if envelopeCode != "" {
		return Code(envelopeCode)
	}
	if code, ok := statusToCode[status]; ok {
		return code
	}
	return CodeUnknown
}

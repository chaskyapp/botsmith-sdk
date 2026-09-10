package conformance

import "context"

// The contract between this runner and an SDK under test. Kept this thin on
// purpose: anything richer would let a case assert something idiomatic, and
// cases must only ever verify observable behaviour.
type ReportedError struct {
	// Code is the envelope error_code when the failure came from the API.
	Code    int
	HasCode bool
	Message string
}

type BotUnderTest interface {
	// Start begins polling and returns immediately.
	Start(ctx context.Context)
	// StartAgain calls Start a second time and reports what happened. It must
	// not block: a bot that is already running has to reject immediately, which
	// is the whole of G1.
	StartAgain() error
	// Stop cancels any in-flight poll and returns once the bot is idle.
	Stop()
	// StoppedItself reports a bot that ended on a terminal error rather than on
	// Stop.
	StoppedItself() bool
	HandlerRuns() map[int64]int
	Errors() []ReportedError
	Warnings() []string
}

type BotOptions struct {
	BaseURL        string
	Token          string
	Limit          int
	TimeoutSeconds int
	Handler        HandlerSpec
}

type Factory func(BotOptions) BotUnderTest

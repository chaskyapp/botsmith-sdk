package conformance

import (
	"context"
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"time"
)

// TestToken is a fixed credential. Never a real token; cases refer to it as
// {token}.
const TestToken = "bot:b1:" + "0000000000000000000000000000000000000000000000000000000000000000"

const defaultTimeout = 5 * time.Second

// After the exchanges run out, how long to watch for a request that should not
// come.
const idleGrace = 200 * time.Millisecond

type Failure struct {
	Where  string
	Detail string
}

func (f Failure) String() string { return f.Where + ": " + f.Detail }

// RunCase executes one runtime case and returns everything that went wrong.
// Management cases go through RunManagementCase instead.
func RunCase(c Case, factory Factory) []Failure {
	if c.Kind == "management" {
		return runManagementCase(c, NewSDKManagement)
	}
	fake := NewFakeServer(c.Exchanges)
	defer fake.Close()

	bot := factory(BotOptions{
		BaseURL:        fake.BaseURL(),
		Token:          TestToken,
		Limit:          c.Bot.Options.Limit,
		TimeoutSeconds: c.Bot.Options.TimeoutSeconds,
		Handler:        c.Bot.Handler,
	})

	timeout := defaultTimeout
	if c.Run.TimeoutMs > 0 {
		timeout = time.Duration(c.Run.TimeoutMs) * time.Millisecond
	}
	ctx, cancel := context.WithCancel(context.Background())
	bot.Start(ctx)

	secondStartRejected := false
	if c.Bot.StartTwice {
		// Give the first Run a moment to take the loop, so the second call is
		// answering "already running" rather than winning a race.
		time.Sleep(50 * time.Millisecond)
		secondStartRejected = bot.StartAgain() != nil
	}

	stopDuration := time.Duration(-1)
	if c.Run.StopAfterMs > 0 {
		time.Sleep(time.Duration(c.Run.StopAfterMs) * time.Millisecond)
		startedStopping := time.Now()
		cancel()
		bot.Stop()
		stopDuration = time.Since(startedStopping)
	} else {
		waitForCompletion(bot, fake, timeout)
		cancel()
		bot.Stop()
	}

	failures := checkRequests(c, fake)
	failures = append(failures, checkAssertions(c, bot, secondStartRejected, stopDuration)...)
	return failures
}

// RunManagementCase drives a case against a specific management client, so a
// test can point it at a deliberately broken one and prove this runner checks.
func RunManagementCase(c Case, factory ManagementFactory) []Failure {
	return runManagementCase(c, factory)
}

func waitForCompletion(bot BotUnderTest, fake *FakeServer, timeout time.Duration) {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if bot.StoppedItself() {
			// Even a stopped bot is watched briefly: one that reports the error
			// and keeps polling is exactly the g7-409 failure this suite exists
			// to catch.
			time.Sleep(idleGrace)
			return
		}
		if fake.Exhausted() {
			time.Sleep(idleGrace)
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func checkRequests(c Case, fake *FakeServer) []Failure {
	var failures []Failure
	captures := Captures{}
	observed := fake.Observed()

	// Per-request problems, collapsed at the end so one defect reads as one
	// line: the idle steady state repeats the same poll many times.
	type problem struct {
		index  int
		detail string
	}
	var problems []problem
	note := func(index int, detail string) { problems = append(problems, problem{index, detail}) }

	repeats := len(c.Exchanges) > 0 && c.Exchanges[len(c.Exchanges)-1].Repeat
	total := len(c.Exchanges)
	if repeats && len(observed) > total {
		total = len(observed)
	}

	for i := 0; i < total; i++ {
		expected := c.Exchanges[min(i, len(c.Exchanges)-1)].Expect
		if i >= len(observed) {
			note(i+1, fmt.Sprintf("expected %s %s, but the SDK never sent it",
				orDefault(expected.Method, "POST"), redact(expected.Path)))
			continue
		}
		actual := observed[i]
		if expected.Method != "" && expected.Method != actual.Method {
			note(i+1, fmt.Sprintf("expected method %s, got %s", expected.Method, actual.Method))
		}
		// The observed path carries the query string; the case declares them
		// separately so a query can be partially matched like a body.
		actualPath, actualQuery, _ := strings.Cut(actual.Path, "?")
		if expected.Path != "" {
			want := strings.ReplaceAll(expected.Path, "{token}", TestToken)
			if want != actualPath {
				note(i+1, fmt.Sprintf("expected path %s, got %s", redact(want), redact(actualPath)))
			}
		}
		if len(expected.Query) > 0 {
			observed := map[string]any{}
			if values, err := url.ParseQuery(actualQuery); err == nil {
				for key := range values {
					observed[key] = values.Get(key)
				}
			}
			if reason := matchPartial(expected.Query, observed, captures, "query"); reason != "" {
				note(i+1, reason)
			}
		}
		if len(expected.Headers) > 0 {
			if reason := matchHeaders(expected.Headers, actual.Headers, captures); reason != "" {
				note(i+1, reason)
			}
		}
		if len(expected.Body) > 0 {
			if reason := matchPartial(expected.Body, actual.Body, captures, "body"); reason != "" {
				note(i+1, reason)
			}
		}
	}

	seen := map[string][]int{}
	var order []string
	for _, p := range problems {
		if _, ok := seen[p.detail]; !ok {
			order = append(order, p.detail)
		}
		seen[p.detail] = append(seen[p.detail], p.index)
	}
	for _, detail := range order {
		indexes := seen[detail]
		where := fmt.Sprintf("request #%d", indexes[0])
		if len(indexes) > 1 {
			where = fmt.Sprintf("requests #%d-#%d (%d times)", indexes[0], indexes[len(indexes)-1], len(indexes))
		}
		failures = append(failures, Failure{Where: where, Detail: detail})
	}

	if extras := fake.Extras(); len(extras) > 0 {
		shown := make([]string, 0, 3)
		for _, e := range extras {
			if len(shown) == 3 {
				break
			}
			shown = append(shown, e.Method+" "+redact(e.Path))
		}
		more := ""
		if rest := len(extras) - len(shown); rest > 0 {
			more = fmt.Sprintf(", +%d more", rest)
		}
		failures = append(failures, Failure{
			Where: "unexpected requests",
			Detail: fmt.Sprintf("the SDK sent %d request(s) after the last declared exchange (%s%s). "+
				"The exchange list is exhaustive: nothing may follow it.", len(extras), strings.Join(shown, ", "), more),
		})
	}
	return failures
}

func checkAssertions(c Case, bot BotUnderTest, secondStartRejected bool, stopDuration time.Duration) []Failure {
	var failures []Failure

	if want := c.Assert.SecondStartRejected; want != nil && *want != secondStartRejected {
		detail := "the second Start was rejected, but this case expected it to be allowed"
		if *want {
			detail = "the second Start succeeded; the SDK now has two polls on one bot"
		}
		failures = append(failures, Failure{Where: "assert.secondStartRejected", Detail: detail})
	}

	if want := c.Assert.StoppedWithinMs; want != nil {
		switch {
		case stopDuration < 0:
			failures = append(failures, Failure{
				Where:  "assert.stoppedWithinMs",
				Detail: "this case asserts on Stop but never called it; add run.stopAfterMs",
			})
		case stopDuration > time.Duration(*want)*time.Millisecond:
			failures = append(failures, Failure{
				Where: "assert.stoppedWithinMs",
				Detail: fmt.Sprintf("Stop took %dms, over the %dms budget — it is waiting out the "+
					"server's response instead of cancelling the request", stopDuration.Milliseconds(), *want),
			})
		}
	}

	if want := c.Assert.BotStopped; want != nil && *want != bot.StoppedItself() {
		detail := "expected the bot to keep running, but it stopped on its own"
		if *want {
			detail = "expected the bot to stop on its own, but it was still running"
		}
		failures = append(failures, Failure{Where: "assert.botStopped", Detail: detail})
	}

	runs := bot.HandlerRuns()
	for _, want := range c.Assert.HandlerRuns {
		if got := runs[want.UpdateID]; got != want.Times {
			failures = append(failures, Failure{
				Where:  "assert.handlerRuns",
				Detail: fmt.Sprintf("update %d: expected %d run(s), got %d", want.UpdateID, want.Times, got),
			})
		}
	}

	errs := bot.Errors()
	for i, want := range c.Assert.ErrorsReported {
		if i >= len(errs) {
			failures = append(failures, Failure{
				Where:  "assert.errorsReported",
				Detail: fmt.Sprintf("expected an error at position %d, none was reported", i),
			})
			continue
		}
		got := errs[i]
		if want.Code != nil && (!got.HasCode || got.Code != *want.Code) {
			failures = append(failures, Failure{
				Where:  "assert.errorsReported",
				Detail: fmt.Sprintf("error #%d: expected code %d, got %d", i+1, *want.Code, got.Code),
			})
		}
		if want.NotContains != "" {
			needle := strings.ReplaceAll(want.NotContains, "{token}", TestToken)
			if strings.Contains(got.Message, needle) {
				failures = append(failures, Failure{
					Where: "assert.errorsReported",
					Detail: fmt.Sprintf("error #%d LEAKS the token. An error crossing the SDK boundary "+
						"must be redacted first.", i+1),
				})
			}
		}
	}

	warnings := bot.Warnings()
	for _, want := range c.Assert.Warnings {
		found := false
		for _, w := range warnings {
			if strings.Contains(strings.ToLower(w), strings.ToLower(want.Contains)) {
				found = true
				break
			}
		}
		if !found {
			failures = append(failures, Failure{
				Where:  "assert.warnings",
				Detail: fmt.Sprintf("expected a warning containing %q, got %v", want.Contains, warnings),
			})
		}
	}
	return failures
}

var botPathPattern = regexp.MustCompile(`/bot[^/\s]+`)

// The runner prints paths, and paths carry the token.
func redact(text string) string {
	return botPathPattern.ReplaceAllString(strings.ReplaceAll(text, TestToken, "<TOKEN>"), "/bot<TOKEN>")
}

func orDefault(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}

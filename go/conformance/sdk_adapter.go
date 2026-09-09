package conformance

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	chaskybot "github.com/chaskyapp/botsmith-sdk/go"
)

// NewSDKBot binds chaskybot to the runner.
type sdkBot struct {
	bot    *chaskybot.Bot
	cancel context.CancelFunc
	done   chan struct{}

	mu            sync.Mutex
	stoppedItself bool
	runs          map[int64]int
	errs          []ReportedError
	warns         []string
}

func NewSDKBot(opts BotOptions) BotUnderTest {
	s := &sdkBot{runs: map[int64]int{}, done: make(chan struct{})}

	bot, err := chaskybot.New(chaskybot.BotOptions{
		Options: chaskybot.Options{
			Token:     opts.Token,
			BaseURL:   opts.BaseURL,
			OnWarning: s.recordWarning,
		},
		Transport: chaskybot.Polling(chaskybot.PollingOptions{
			Limit:          opts.Limit,
			TimeoutSeconds: opts.TimeoutSeconds,
			// Short so a case exercising a retry finishes inside its timeout.
			RetryBase: 20 * time.Millisecond,
			RetryMax:  200 * time.Millisecond,
		}),
	})
	if err != nil {
		panic(fmt.Sprintf("conformance: could not build the bot: %s", err))
	}

	spec := opts.Handler
	bot.Handle(func(ctx context.Context, e *chaskybot.Event) error {
		id := e.Update.ID
		s.mu.Lock()
		s.runs[id]++
		s.mu.Unlock()

		for _, thrown := range spec.ThrowOnUpdateIds {
			if thrown == id {
				return fmt.Errorf("handler failed on update %d", id)
			}
		}
		if spec.Kind == "noop" {
			return nil
		}
		text := spec.ReplyText
		if text == "" {
			text = e.Message.Text
		}
		_, err := e.Reply(ctx, text)
		return err
	})
	bot.OnError(s.recordError)

	s.bot = bot
	return s
}

func (s *sdkBot) Start(ctx context.Context) {
	runCtx, cancel := context.WithCancel(ctx)
	s.cancel = cancel
	go func() {
		defer close(s.done)
		// Run returns the terminal error; cancellation returns nil. That is why
		// this SDK has no OnFatal: in Go, an error that ends the loop belongs in
		// the return value.
		if err := s.bot.Run(runCtx); err != nil && !errors.Is(err, context.Canceled) {
			s.mu.Lock()
			s.stoppedItself = true
			s.mu.Unlock()
			// A terminal failure is also an error the caller sees: cases assert
			// on it by position in Errors(), so hiding it would make those
			// assertions untestable.
			s.recordError(err)
		}
	}()
}

func (s *sdkBot) Stop() {
	if s.cancel != nil {
		s.cancel()
	}
	select {
	case <-s.done:
	case <-time.After(2 * time.Second):
		// Never block the whole suite on one bot that will not stop; the case
		// fails on its assertions instead.
	}
}

func (s *sdkBot) StoppedItself() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.stoppedItself
}

func (s *sdkBot) HandlerRuns() map[int64]int {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := map[int64]int{}
	for k, v := range s.runs {
		out[k] = v
	}
	return out
}

func (s *sdkBot) Errors() []ReportedError {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]ReportedError{}, s.errs...)
}

func (s *sdkBot) Warnings() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string{}, s.warns...)
}

func (s *sdkBot) recordError(err error) {
	reported := ReportedError{Message: err.Error()}
	var api *chaskybot.APIError
	if errors.As(err, &api) {
		reported.Code, reported.HasCode = api.Code, true
	}
	s.mu.Lock()
	s.errs = append(s.errs, reported)
	s.mu.Unlock()
}

func (s *sdkBot) recordWarning(message string) {
	s.mu.Lock()
	s.warns = append(s.warns, message)
	s.mu.Unlock()
}

package conformance

import (
	"context"
	"errors"
	"fmt"
	"io"
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
	seen          []any
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
	// Counted in the catch-all hook, so an update kind the SDK has no type for
	// is counted too (G10).
	bot.HandleUpdate(func(ctx context.Context, u *chaskybot.Update) error {
		s.mu.Lock()
		s.runs[u.ID]++
		s.mu.Unlock()
		return nil
	})
	bot.Handle(func(ctx context.Context, e *chaskybot.Event) error {
		id := e.Update.ID

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
		var opts chaskybot.ReplyOptions
		if spec.MentionBack {
			// Nil when the message mentioned no one: the field must not be sent.
			for _, m := range e.Message.Mentions {
				if opts.Mentions == nil {
					opts.Mentions = map[string]string{}
				}
				opts.Mentions[m.Name] = m.UserID
			}
		}
		_, err := e.ReplyWith(ctx, text, opts)
		return err
	})
	if spec.RecordAttachments {
		bot.HandleAttachment(func(ctx context.Context, e *chaskybot.Event) error {
			attachments := []any{}
			for _, a := range e.Message.Attachments {
				wire := wireAttachment(a)
				if spec.DownloadAttachments {
					n, err := countBytes(ctx, bot.Client(), a)
					if err != nil {
						return err
					}
					wire["downloadedBytes"] = n
				}
				attachments = append(attachments, wire)
			}
			// Back into wire names, so the case compares one shape across
			// languages (SCHEMA.md, attachmentsSeen).
			s.mu.Lock()
			s.seen = append(s.seen, map[string]any{
				"updateId":             e.Update.ID,
				"text":                 e.Message.Text,
				"caption":              e.Message.Caption,
				"attachmentsTruncated": e.Message.AttachmentsTruncated,
				"attachments":          attachments,
			})
			s.mu.Unlock()
			return nil
		})
	}
	for name, text := range spec.Commands {
		text := text
		bot.Command(name, func(ctx context.Context, e *chaskybot.Event) error {
			_, err := e.Reply(ctx, text)
			return err
		})
	}
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

// StartAgain runs the bot with an already-cancelled context.
//
// If the bot is running, Run rejects before it ever looks at the context, which
// is the answer this asks for. If it is not, the cancelled context makes Run
// return immediately instead of blocking the suite — so the call is safe either
// way and the two outcomes stay distinguishable.
func (s *sdkBot) StartAgain() error {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	return s.bot.Run(ctx)
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

func (s *sdkBot) AttachmentsSeen() []any {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]any{}, s.seen...)
}

func wireAttachment(a chaskybot.Attachment) map[string]any {
	wire := map[string]any{
		"file_id":   a.FileID,
		"kind":      a.Kind,
		"file_name": a.FileName,
		"mime_type": a.MimeType,
		"file_size": a.FileSize,
		"url":       a.URL,
	}
	if a.Width != 0 {
		wire["width"] = a.Width
	}
	if a.Height != 0 {
		wire["height"] = a.Height
	}
	if a.Duration != 0 {
		wire["duration"] = a.Duration
	}
	return wire
}

func countBytes(ctx context.Context, c *chaskybot.Client, a chaskybot.Attachment) (int64, error) {
	body, err := c.Download(ctx, a)
	if err != nil {
		return 0, err
	}
	defer body.Close()
	return io.Copy(io.Discard, body)
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

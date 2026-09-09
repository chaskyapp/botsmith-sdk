package chaskybot

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"regexp"
	"strings"
	"sync"
	"time"
)

// Event is one update delivered to a handler, with the shortcuts for answering
// it. Named Event rather than Context so it never reads as a context.Context.
type Event struct {
	Update  Update
	Message *Message
	ChatID  ChatID

	client   *Client
	attempts int
	onError  func(error)
}

// Reply sends to this update's chat with a managed Idempotency-Key.
func (e *Event) Reply(ctx context.Context, text string) (*Message, error) {
	return sendWithRetry(ctx, e.client, SendMessageParams{
		// G9: the chat id goes back exactly as it arrived. Never parsed, never
		// rebuilt — a real chat id carries "bot:" twice, and anything that
		// takes it apart breaks against a live server.
		ChatID: e.ChatID,
		Text:   text,
	}, e.attempts, e.onError)
}

// Typing is explicit on purpose: the runtime never sends a chat action by
// itself. Whether the indicator helps depends on how long the bot takes, which
// is the author's call, not the SDK's.
func (e *Event) Typing(ctx context.Context) error {
	return e.client.SendChatAction(ctx, e.ChatID, ActionTyping)
}

type Handler func(ctx context.Context, e *Event) error

type BotOptions struct {
	Options
	Transport Transport
	// SendAttempts bounds the retries of one logical send. All of them reuse
	// the same Idempotency-Key.
	SendAttempts int
}

type Bot struct {
	client    *Client
	transport Transport
	attempts  int

	mu       sync.Mutex
	running  bool
	commands map[string]Handler
	handlers []Handler
	onErrors []func(error)
}

func New(opts BotOptions) (*Bot, error) {
	client, err := NewClient(opts.Options)
	if err != nil {
		return nil, err
	}
	transport := opts.Transport
	if transport == nil {
		transport = Polling(PollingOptions{})
	}
	attempts := opts.SendAttempts
	if attempts <= 0 {
		attempts = 4
	}
	return &Bot{client: client, transport: transport, attempts: attempts, commands: map[string]Handler{}}, nil
}

func (b *Bot) Client() *Client { return b.client }

func (b *Bot) Command(name string, h Handler) *Bot {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.commands[strings.TrimPrefix(name, "/")] = h
	return b
}

// Handle registers a handler for any text message that matched no command.
func (b *Bot) Handle(h Handler) *Bot {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.handlers = append(b.handlers, h)
	return b
}

func (b *Bot) OnError(fn func(error)) *Bot {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.onErrors = append(b.onErrors, fn)
	return b
}

// ErrAlreadyRunning guards G1: exactly one in-flight poll per instance. Two
// overlapping polls on one bot used to split the updates silently; the server
// now answers 409, but the SDK should never be the one causing it.
var ErrAlreadyRunning = errors.New("chaskybot: this bot is already running")

// Run blocks until ctx is cancelled, which returns nil, or until a terminal
// failure such as 401, 403 or 409 CONFLICT_POLLING, which is returned.
func (b *Bot) Run(ctx context.Context) error {
	b.mu.Lock()
	if b.running {
		b.mu.Unlock()
		return ErrAlreadyRunning
	}
	b.running = true
	b.mu.Unlock()
	defer func() {
		b.mu.Lock()
		b.running = false
		b.mu.Unlock()
	}()

	return b.transport.Run(ctx, TransportDeps{
		Client:   b.client,
		OnUpdate: b.dispatch,
		OnError:  b.emitError,
	})
}

func (b *Bot) emitError(err error) {
	b.mu.Lock()
	listeners := append([]func(error){}, b.onErrors...)
	b.mu.Unlock()
	for _, fn := range listeners {
		fn(err)
	}
}

func (b *Bot) dispatch(ctx context.Context, update Update) error {
	if update.Message == nil {
		return nil
	}
	event := &Event{
		Update:   update,
		Message:  update.Message,
		ChatID:   update.Message.Chat.ID,
		client:   b.client,
		attempts: b.attempts,
		onError:  b.emitError,
	}

	b.mu.Lock()
	handler, isCommand := b.commands[parseCommand(update.Message.Text)]
	fallbacks := append([]Handler{}, b.handlers...)
	b.mu.Unlock()

	if isCommand {
		return handler(ctx, event)
	}
	for _, fn := range fallbacks {
		if err := fn(ctx, event); err != nil {
			return err
		}
	}
	return nil
}

// sendWithRetry implements G4: one key per logical message, the SAME key on
// every retry of THAT message.
//
// The key is generated once, outside the loop. A fresh key per attempt turns a
// retry into a second message and the user sees the bot answer twice; reusing
// one key across different messages makes the server discard the second
// SILENTLY, which is worse because it looks like it worked.
func sendWithRetry(ctx context.Context, c *Client, p SendMessageParams, attempts int, onError func(error)) (*Message, error) {
	key, err := newIdempotencyKey()
	if err != nil {
		return nil, err
	}
	p.IdempotencyKey = key

	var last error
	for attempt := 1; attempt <= attempts; attempt++ {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		message, err := c.SendMessage(ctx, p)
		if err == nil {
			return message, nil
		}
		last = err
		if classify(err, sourceCall) != classTransient {
			return nil, err
		}
		if attempt == attempts {
			break
		}
		if onError != nil {
			onError(err)
		}
		if !sleepCtx(ctx, backoff(attempt, 250*time.Millisecond, 4*time.Second)) {
			return nil, ctx.Err()
		}
	}
	return nil, last
}

func newIdempotencyKey() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		// Without randomness a unique key cannot be produced, and reusing one
		// makes the server drop the message without saying so. Not sending is
		// the safer failure: it is visible.
		return "", &UsageError{Message: "no secure randomness available to build an Idempotency-Key; refusing to send"}
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	s := hex.EncodeToString(b[:])
	return s[:8] + "-" + s[8:12] + "-" + s[12:16] + "-" + s[16:20] + "-" + s[20:], nil
}

var commandPattern = regexp.MustCompile(`^/([A-Za-z0-9_]+)`)

func parseCommand(text string) string {
	match := commandPattern.FindStringSubmatch(strings.TrimSpace(text))
	if match == nil {
		return ""
	}
	return match[1]
}

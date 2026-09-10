package admin

import (
	"context"
	"errors"
	"fmt"
)

// Ergonomic wrappers over the dialogue.
//
// /bot-management/commands is a conversational state machine: creating a bot is
// /newbot, the name, the username, confirm — four chained POSTs, each carrying
// the revision the last one returned. That is the right shape for a person
// typing in a portal and a hostile one for a CI job.
//
// Absorbing it is the same job the runtime does with offset arithmetic and
// idempotency keys: the caller says what they want once, the SDK deals with the
// protocol.
//
// Two things this cannot hide, so it does not pretend to:
//
//   - It is still four round trips. Fine for provisioning, wrong for a hot path.
//   - The dialogue is ONE shared conversation per actor, guarded by
//     expectedRevision. If a person has the portal open, or another process is
//     driving it, the revision moves underneath and the server answers
//     STALE_STATE. This retries from a fresh read a bounded number of times and
//     then gives up rather than fighting for the conversation.

type CreateBotParams struct {
	Name     string
	Username string
	// StaleRetries bounds the attempts when another writer moves the revision
	// underneath us. Zero means the default.
	StaleRetries int
}

type CreateBotResult struct {
	BotID string
	Event Event
}

// CreateBot creates a bot in one call, driving the four-step dialogue.
func (c *Client) CreateBot(ctx context.Context, p CreateBotParams) (CreateBotResult, error) {
	retries := p.StaleRetries
	if retries <= 0 {
		retries = 2
	}
	var last error
	for attempt := 0; attempt <= retries; attempt++ {
		result, err := c.runCreate(ctx, p)
		if err == nil {
			return result, nil
		}
		last = err
		var failure *Error
		if !errors.As(err, &failure) || failure.Code != CodeStaleState {
			return CreateBotResult{}, err
		}
		// Someone else advanced the conversation. Re-read and walk it again.
	}
	return CreateBotResult{}, last
}

func (c *Client) runCreate(ctx context.Context, p CreateBotParams) (result CreateBotResult, err error) {
	page, err := c.Dialogue(ctx, Page{Limit: 1})
	if err != nil {
		return CreateBotResult{}, err
	}
	revision := page.Current.Revision
	started := false

	defer func() {
		// Driving a shared conversation means owning its cleanup. Left alone,
		// the next person to open the portal finds it parked on "enter a
		// username" for a bot they never asked for.
		if err != nil && started {
			c.cancelQuietly(ctx, revision)
		}
	}()

	step, err := c.Command(ctx, CommandParams{Command: CommandNewBot, ExpectedRevision: revision})
	if err != nil {
		return CreateBotResult{}, err
	}
	started = true
	revision = step.Event.Revision

	// The server normalises both values and can answer with something other than
	// what went in, so each step's revision comes from ITS response rather than
	// from counting.
	if step, err = c.Command(ctx, CommandParams{Command: CommandValue, Value: p.Name, ExpectedRevision: revision}); err != nil {
		return CreateBotResult{}, err
	}
	revision = step.Event.Revision

	if step, err = c.Command(ctx, CommandParams{Command: CommandValue, Value: p.Username, ExpectedRevision: revision}); err != nil {
		return CreateBotResult{}, err
	}
	revision = step.Event.Revision

	if step, err = c.Command(ctx, CommandParams{Command: CommandConfirm, ExpectedRevision: revision}); err != nil {
		return CreateBotResult{}, err
	}
	if step.Event.Receipt.BotID == "" {
		err = fmt.Errorf("admin: the dialogue confirmed a bot but returned no botID; refusing to guess one")
		return CreateBotResult{}, err
	}
	return CreateBotResult{BotID: step.Event.Receipt.BotID, Event: step.Event}, nil
}

func (c *Client) cancelQuietly(ctx context.Context, revision int64) {
	// The original failure is the one worth reporting. A cleanup that also
	// fails must not replace it, or the caller learns about the wrong problem.
	_, _ = c.Command(ctx, CommandParams{Command: CommandCancel, ExpectedRevision: revision})
}

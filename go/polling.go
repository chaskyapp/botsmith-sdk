package chaskybot

import (
	"context"
	"math"
	"math/rand"
	"time"
)

// TransportDeps is what a transport needs from the bot. OnError receives
// recoverable problems; anything terminal is RETURNED by Run, because in Go an
// error that ends the loop belongs in the return value, not in a callback.
type TransportDeps struct {
	Client   *Client
	OnUpdate func(ctx context.Context, u Update) error
	OnError  func(err error)
}

// Transport is the seam for D4. Polling is the only implementation today; when
// the server grows outbound webhooks, a Webhook transport joins it and the
// caller's handlers do not change. That is the whole promise — nothing about
// the webhook's shape is committed here, because the server has not built it.
type Transport interface {
	Kind() string
	// Run blocks until ctx is cancelled, which returns nil, or until a terminal
	// failure, which is returned.
	Run(ctx context.Context, deps TransportDeps) error
}

type PollingOptions struct {
	Limit          int
	TimeoutSeconds int
	// RetryBase is the first delay after a transient failure; it doubles, with
	// jitter, up to RetryMax.
	RetryBase time.Duration
	RetryMax  time.Duration
}

func Polling(opts PollingOptions) Transport { return &poller{opts: opts} }

type poller struct{ opts PollingOptions }

func (p *poller) Kind() string { return "polling" }

func (p *poller) Run(ctx context.Context, deps TransportDeps) error {
	base := p.opts.RetryBase
	if base <= 0 {
		base = 250 * time.Millisecond
	}
	maxDelay := p.opts.RetryMax
	if maxDelay <= 0 {
		maxDelay = 8 * time.Second
	}

	// The ENTIRE state of the loop: one integer.
	//
	// It is both the dedup threshold (G3) and the source of the offset (G2),
	// which are the same number — offset == lastSeen+1 holds at all times.
	// Keeping two fields in sync would be a bug waiting for the day they
	// diverge.
	lastSeen := int64(-1)
	failures := 0

	for {
		if err := ctx.Err(); err != nil {
			return nil
		}

		batch, err := deps.Client.GetUpdates(ctx, GetUpdatesParams{
			Offset:         lastSeen + 1,
			Limit:          p.opts.Limit,
			TimeoutSeconds: p.opts.TimeoutSeconds,
		})
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			if classify(err, sourcePoll) == classTerminal {
				// 401, 403 and 409 while polling all mean the same thing: this
				// bot will not be allowed to poll. Retrying a 409 in particular
				// is an eviction war — two instances displacing each other
				// forever, neither processing anything (§3.1).
				return err
			}
			deps.OnError(err)
			failures++
			if !sleepCtx(ctx, backoff(failures, base, maxDelay)) {
				return nil
			}
			continue
		}
		failures = 0

		for _, update := range batch {
			if ctx.Err() != nil {
				return nil
			}
			// G3: a threshold, not a data structure. The server delivers in
			// strictly ascending order and emits no regressive ids, so anything
			// at or below the threshold is a redelivery — including a full
			// stream replay after the consumer group is recreated, where a
			// finite window would fail.
			if update.ID <= lastSeen {
				continue
			}

			// G2, and the order is the point: the cursor advances BEFORE the
			// handler runs, so a handler that fails cannot pin the bot on one
			// update forever. The offset is a read cursor, not a business
			// acknowledgement.
			lastSeen = update.ID

			if err := deps.OnUpdate(ctx, update); err != nil {
				deps.OnError(err)
			}
		}
	}
}

func backoff(attempt int, base, max time.Duration) time.Duration {
	d := float64(base) * math.Pow(2, float64(attempt-1))
	if d > float64(max) {
		d = float64(max)
	}
	// Jitter so many bots recovering from one outage do not resynchronise into
	// a thundering herd against the API.
	return time.Duration(d * (0.5 + rand.Float64()*0.5))
}

// sleepCtx reports false if the context ended first.
func sleepCtx(ctx context.Context, d time.Duration) bool {
	if d <= 0 {
		return ctx.Err() == nil
	}
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

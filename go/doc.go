// Package chaskybot is the client SDK for the Chasky Bot API.
//
// It is a port of the contract in ../docs/00-spec.md, not of the TypeScript
// SDK. The guarantees (G1-G9) and delegations (L1-L5) are identical and the
// shared conformance suite verifies that; the shape is Go's. Concurrency is
// context.Context, failures are error values, and Run blocks like any other
// server loop.
//
// Basic use:
//
//	bot, err := chaskybot.New(chaskybot.Options{Token: os.Getenv("CHASKY_BOT_TOKEN")})
//	if err != nil {
//		return err
//	}
//	bot.Command("start", func(ctx context.Context, e *chaskybot.Event) error {
//		_, err := e.Reply(ctx, "Hello.")
//		return err
//	})
//	bot.Handle(func(ctx context.Context, e *chaskybot.Event) error {
//		_, err := e.Reply(ctx, "You said: "+e.Message.Text)
//		return err
//	})
//	return bot.Run(ctx)
//
// Three things the contract insists on, because they are what a hand-written
// client gets wrong:
//
//   - Exactly one process may poll a bot. Starting a second one evicts the
//     first, which then receives 409 CONFLICT_POLLING and stops.
//   - The offset always advances, even past an update whose handler failed. It
//     is a read cursor, not a business acknowledgement.
//   - The token travels in the URL path, so it leaks into transport errors.
//     Every error this package returns has been redacted first.
package chaskybot

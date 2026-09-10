// Package admin is the client for BotSmith, the Chasky bot administration
// surface at /bot-management.
//
// NOT FOR BOT AUTHORS. The credential here administers bots — it can create
// them, rotate their tokens and point their webhooks somewhere else — while the
// chaskybot package next door needs only a bot token and can do none of that.
// They are named and published separately so a bot author never installs this
// one by accident.
//
// The credential is EXACTLY ONE of two, never both:
//
//	DeveloperKey  sk_...  a developer administering their own bots from their
//	                      own code, issued from BotSmith and revocable on its own
//	BearerToken           a human session, which is how the portal's own backend
//	                      calls this surface
//
// Until the developer-key delta these routes sat behind Chasky's global API
// secret gate, so calling one needed X-Secret: the platform's own secret, which
// no third party has or should have. That is exactly why a third party could
// not administer their own bots, and why the keys exist. The group is now
// public at the routing layer and carries its own guard instead.
//
// It is a SEPARATE package from chaskybot on purpose, and the separation is
// requirement R-B in §6 of the contract rather than a stylistic choice. The two
// surfaces authenticate differently — a bot token in the path versus a
// developer key or a human session in a header — use incompatible envelopes,
// and disagree about what a 409 means:
//
//	chaskybot  409 CONFLICT_POLLING  another instance evicted you  -> STOP
//	admin      409 STALE_STATE       your revision is stale        -> RE-READ AND RETRY
//
// Same number, opposite instruction. With one shared error type, an
// `if code == 409 { retry() }` written for admin and reused in the runtime
// puts two bots into an eviction war. With two, it does not compile against the
// wrong surface.
//
// The server's decoder is strict: an unknown field, a duplicate field, or a
// null — even where the field is optional — is 400 INVALID_INPUT. Every request
// body here is therefore built field by field, adding only what is set.
package admin

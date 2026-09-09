// Package management is the client for BotSmith, the Chasky bot administration
// surface at /bot-management.
//
// It is a SEPARATE package from chaskybot on purpose, and the separation is
// requirement R-B in §6 of the contract rather than a stylistic choice. The two
// surfaces authenticate differently — a bot token in the path versus a human
// session plus the platform secret — use incompatible envelopes, and disagree
// about what a 409 means:
//
//	chaskybot  409 CONFLICT_POLLING  another instance evicted you  -> STOP
//	management 409 STALE_STATE       your revision is stale        -> RE-READ AND RETRY
//
// Same number, opposite instruction. With one shared error type, an
// `if code == 409 { retry() }` written for management and reused in the runtime
// puts two bots into an eviction war. With two, it does not compile against the
// wrong surface.
//
// The server's decoder is strict: an unknown field, a duplicate field, or a
// null — even where the field is optional — is 400 INVALID_INPUT. Every request
// body here is therefore built field by field, adding only what is set.
package management

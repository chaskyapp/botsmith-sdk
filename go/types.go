package chaskybot

import "time"

// Identifiers are strings and this package never converts one. See §9 of the
// contract: a real chat id carries the "bot:" prefix twice, so anything that
// "understands" the format well enough to split it apart breaks on a live
// server. An id is an opaque label.
type (
	ChatID    = string
	UserID    = string
	MessageID = string
)

// UpdateID is the one numeric identifier: an int64 counter, one per bot.
// Gaps in the sequence are valid and are not loss.
type UpdateID = int64

type User struct {
	ID   UserID
	Name string
}

type Chat struct {
	ID   ChatID
	Type string
}

type Message struct {
	ID   MessageID
	From User
	Chat Chat
	// The wire carries seconds since the epoch.
	Date time.Time
	Text string
}

type Update struct {
	ID      UpdateID
	Message *Message
}

type Identity struct {
	ID       UserID
	IsBot    bool
	Username string
	// Mapped from the server's first_name, which is Telegram-shaped while the
	// rest of the contract is Chasky-shaped. Server request S2 in §13.
	DisplayName string
}

// WebhookInfo is what getWebhookInfo reports.
//
// An empty State means the bot has no destination registered and is still
// polling; active and suspended are the webhook states. HasSecretToken answers
// "is one configured", never "which one" — the server does not reveal it and
// neither does this.
type WebhookInfo struct {
	URL                string
	HasSecretToken     bool
	PendingUpdateCount int64
	// LastError* describe the LAST RUN of failures, not all time: a successful
	// delivery clears them. An error from three days ago beside a working
	// webhook explains nothing.
	LastErrorAt      time.Time
	LastErrorMessage string
	// State is empty while polling.
	State string
}

type wireWebhookInfo struct {
	URL                string `json:"url"`
	HasSecretToken     bool   `json:"has_secret_token"`
	PendingUpdateCount int64  `json:"pending_update_count"`
	LastErrorDate      int64  `json:"last_error_date"`
	LastErrorMessage   string `json:"last_error_message"`
	State              string `json:"state"`
}

// ChatAction is a closed set on purpose: Telegram's vocabulary is valid in
// Telegram and 400 ACTION_NOT_SUPPORTED here.
type ChatAction string

const ActionTyping ChatAction = "typing"

// Wire shapes, unexported: the domain types above are the contract.
type wireUser struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type wireChat struct {
	ID   string `json:"id"`
	Type string `json:"type"`
}

type wireMessage struct {
	MessageID string    `json:"message_id"`
	From      *wireUser `json:"from"`
	Chat      wireChat  `json:"chat"`
	Date      int64     `json:"date"`
	Text      string    `json:"text"`
}

type wireUpdate struct {
	UpdateID int64        `json:"update_id"`
	Message  *wireMessage `json:"message"`
}

type wireIdentity struct {
	ID          string `json:"id"`
	Username    string `json:"username"`
	FirstName   string `json:"first_name"`
	DisplayName string `json:"display_name"`
}

func (m *wireMessage) toMessage() *Message {
	if m == nil {
		return nil
	}
	out := &Message{
		ID:   m.MessageID,
		Chat: Chat{ID: m.Chat.ID, Type: m.Chat.Type},
		Date: time.Unix(m.Date, 0).UTC(),
		Text: m.Text,
	}
	if m.From != nil {
		out.From = User{ID: m.From.ID, Name: m.From.Name}
	}
	return out
}

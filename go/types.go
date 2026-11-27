package chaskybot

import (
	"encoding/json"
	"time"
)

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
	// IsBot is sent in groups and absent in a 1:1, where the sender is always a
	// person; nil means "not said", which is not the same as false.
	IsBot *bool
}

type Chat struct {
	ID ChatID
	// Type is `private` or `group` today. A string on purpose: a value this
	// version does not know is passed through, never rejected (G10).
	Type string
	// Title is the group's name; only groups have one.
	Title string
}

// ReplyTo is the message being answered, as the server summarises it.
type ReplyTo struct {
	MessageID MessageID
	From      User
	// Truncated by the server to 500 characters.
	Text string
}

// ChatMemberState is `member` or `left`; the modes only travel while the bot is
// a member.
type ChatMemberState struct {
	Status string
	// ReadMode is `all` or `mentions`.
	ReadMode string
	// HistoryMode is `full` or `since_join`.
	HistoryMode string
}

// ChatMemberUpdated: the bot was added to a group, had its modes changed, or
// left it.
type ChatMemberUpdated struct {
	Chat Chat
	// From is who made the change.
	From     User
	Date     time.Time
	OldState ChatMemberState
	NewState ChatMemberState
}

type Message struct {
	ID   MessageID
	From User
	Chat Chat
	// The wire carries seconds since the epoch.
	Date    time.Time
	Text    string
	ReplyTo *ReplyTo
}

type Update struct {
	ID           UpdateID
	Message      *Message
	MyChatMember *ChatMemberUpdated
	// Raw is the update exactly as the server sent it. For a kind this version
	// has no field for it is the only way to read it, and it still arrives (G10).
	Raw json.RawMessage
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
	ID    string `json:"id"`
	Name  string `json:"name"`
	IsBot *bool  `json:"is_bot"`
}

type wireChat struct {
	ID    string `json:"id"`
	Type  string `json:"type"`
	Title string `json:"title"`
}

type wireMemberState struct {
	Status      string `json:"status"`
	ReadMode    string `json:"read_mode"`
	HistoryMode string `json:"history_mode"`
}

type wireMemberUpdate struct {
	Chat     wireChat        `json:"chat"`
	From     *wireUser       `json:"from"`
	Date     int64           `json:"date"`
	OldState wireMemberState `json:"old_state"`
	NewState wireMemberState `json:"new_state"`
}

type wireMessage struct {
	MessageID string    `json:"message_id"`
	From      *wireUser `json:"from"`
	Chat      wireChat  `json:"chat"`
	Date      int64     `json:"date"`
	Text      string    `json:"text"`
	ReplyTo   *struct {
		MessageID string    `json:"message_id"`
		From      *wireUser `json:"from"`
		Text      string    `json:"text"`
	} `json:"reply_to_message"`
}

type wireUpdate struct {
	UpdateID     int64             `json:"update_id"`
	Message      *wireMessage      `json:"message"`
	MyChatMember *wireMemberUpdate `json:"my_chat_member"`
}

// toUpdate keeps the raw bytes: a kind without a field here still becomes an
// Update (G10).
func (u wireUpdate) toUpdate(raw json.RawMessage) Update {
	out := Update{ID: u.UpdateID, Message: u.Message.toMessage(), Raw: raw}
	if m := u.MyChatMember; m != nil {
		out.MyChatMember = &ChatMemberUpdated{
			Chat:     Chat{ID: m.Chat.ID, Type: m.Chat.Type, Title: m.Chat.Title},
			From:     m.From.toUser(),
			Date:     time.Unix(m.Date, 0).UTC(),
			OldState: ChatMemberState(m.OldState),
			NewState: ChatMemberState(m.NewState),
		}
	}
	return out
}

func (u *wireUser) toUser() User {
	if u == nil {
		return User{}
	}
	return User{ID: u.ID, Name: u.Name, IsBot: u.IsBot}
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
		Chat: Chat{ID: m.Chat.ID, Type: m.Chat.Type, Title: m.Chat.Title},
		From: m.From.toUser(),
		Date: time.Unix(m.Date, 0).UTC(),
		Text: m.Text,
	}
	if r := m.ReplyTo; r != nil {
		out.ReplyTo = &ReplyTo{MessageID: r.MessageID, From: r.From.toUser(), Text: r.Text}
	}
	return out
}

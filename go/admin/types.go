package admin

import "time"

type BotView struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Username    string `json:"username"`
	Description string `json:"description"`
	State       string `json:"state"`
	// Visibility is what the dialogue compare-and-sets when publishing, as
	// State is when archiving.
	Visibility string `json:"visibility"`
	// WebhookURL is the destination. The SECRET appears here in no view.
	WebhookURL        string `json:"webhookUrl"`
	WebhookState      string `json:"webhookState"`
	CredentialState   string `json:"credentialState"`
	CredentialVersion int64  `json:"credentialVersion"`
	MetadataVersion   int64  `json:"metadataVersion"`
}

type Capability struct {
	Enabled                 bool `json:"enabled"`
	CanManageAdministrators bool `json:"canManageAdministrators"`
	// MaxBots lets a client warn BEFORE the user spends four steps typing a
	// name and username only to be refused at confirm. The cap is still the
	// backend's: this announces it, it does not decide it.
	MaxBots int `json:"maxBots"`
	// WebhookEnabled announces the gate so a client does not offer a button
	// that always fails.
	WebhookEnabled bool `json:"webhookEnabled"`
	// DeveloperKeysEnabled announces whether the server has developer keys
	// wired, for the same reason.
	DeveloperKeysEnabled bool `json:"developerKeysEnabled"`
}

type BotPage struct {
	Items      []BotView `json:"items"`
	NextCursor string    `json:"nextCursor,omitempty"`
	HasMore    bool      `json:"hasMore"`
}

type Step string

const (
	StepMenu            Step = "menu"
	StepNewName         Step = "new_name"
	StepNewUsername     Step = "new_username"
	StepConfirmCreate   Step = "confirm_create"
	StepSelectBot       Step = "select_bot"
	StepBotMenu         Step = "bot_menu"
	StepEditName        Step = "edit_name"
	StepEditDescription Step = "edit_description"
	StepWebhookURL      Step = "webhook_url"
	StepKeys            Step = "keys"
	StepKeyLabel        Step = "key_label"
	StepKeyPreview      Step = "key_preview"
	StepConfirmChange   Step = "confirm_change"
)

type OperationState string

const (
	OperationPending   OperationState = "pending"
	OperationCompleted OperationState = "completed"
	OperationRejected  OperationState = "rejected"
)

type Draft struct {
	Name                      string `json:"name,omitempty"`
	Username                  string `json:"username,omitempty"`
	Description               string `json:"description,omitempty"`
	BotID                     string `json:"botID,omitempty"`
	Action                    string `json:"action,omitempty"`
	ExpectedMetadataVersion   *int64 `json:"expectedMetadataVersion,omitempty"`
	ExpectedCredentialVersion *int64 `json:"expectedCredentialVersion,omitempty"`
	KeyLabel                  string `json:"keyLabel,omitempty"`
	KeyPreview                string `json:"keyPreview,omitempty"`
}

type Receipt struct {
	OperationID       string         `json:"operationID"`
	BotID             string         `json:"botID,omitempty"`
	CredentialVersion int64          `json:"credentialVersion,omitempty"`
	State             OperationState `json:"state"`
}

type Event struct {
	Revision int64   `json:"revision"`
	Step     Step    `json:"step"`
	Draft    Draft   `json:"draft"`
	Receipt  Receipt `json:"receipt"`
	// MessageCode is a CODE, not rendered text. The server is explicit that
	// codes are the durable transcript format and user-facing text is rendered
	// from them, so this package promises no readable message.
	MessageCode string    `json:"messageCode"`
	CreatedAt   time.Time `json:"createdAt"`
}

type DialoguePage struct {
	Current    Event   `json:"current"`
	Items      []Event `json:"items"`
	NextCursor string  `json:"nextCursor,omitempty"`
	HasMore    bool    `json:"hasMore"`
}

// SecretReveal carries a live token. The server marks it response-only — its
// own String() prints "[credential redacted]" — so it is returned to the caller
// and retained nowhere else.
type SecretReveal struct {
	BotID   string `json:"botID"`
	Token   string `json:"token"`
	Version int64  `json:"version"`
}

func (SecretReveal) String() string   { return "[credential redacted]" }
func (SecretReveal) GoString() string { return "[credential redacted]" }

// DeveloperKeyReveal carries a live developer key, and exists only in the
// response to the confirm that issued it: the server keeps just its hash. It is
// returned to the caller and retained nowhere else, and String and GoString
// are redacted so it cannot land in a log by accident.
type DeveloperKeyReveal struct {
	Value     string    `json:"value"`
	OwnerID   string    `json:"ownerID"`
	CreatedAt time.Time `json:"createdAt"`
}

func (DeveloperKeyReveal) String() string   { return "[developer key redacted]" }
func (DeveloperKeyReveal) GoString() string { return "[developer key redacted]" }

// DeveloperKeyView is what a listing shows about a key: its publishable preview
// (sk_ + 6 hex, enough to recognise it and to revoke it), never the hash or the
// value. A revoked key is listed on purpose, as the record that it existed.
type DeveloperKeyView struct {
	Preview   string     `json:"preview"`
	Label     string     `json:"label,omitempty"`
	CreatedAt time.Time  `json:"createdAt"`
	RevokedAt *time.Time `json:"revokedAt,omitempty"`
}

type CommandResult struct {
	Event  Event         `json:"event"`
	Secret *SecretReveal `json:"secret,omitempty"`
	// DeveloperKey is only on the confirm that issued a key: the one copy that
	// will ever exist. Without this field a typed decoder drops it in silence.
	DeveloperKey     *DeveloperKeyReveal `json:"developerKey,omitempty"`
	RecoveryRequired bool                `json:"recoveryRequired,omitempty"`
}

func (CommandResult) String() string   { return "[admin command result redacted]" }
func (CommandResult) GoString() string { return "[admin command result redacted]" }

type GrantView struct {
	TargetID string `json:"targetID"`
	Revision int64  `json:"revision"`
	Enabled  bool   `json:"enabled"`
}

// CommandKind is the dialogue's vocabulary, closed as the server declares it.
type CommandKind string

const (
	CommandNewBot      CommandKind = "/newbot"
	CommandMyBots      CommandKind = "/mybots"
	CommandHelp        CommandKind = "/help"
	CommandCancel      CommandKind = "/cancel"
	CommandValue       CommandKind = "value"
	CommandSelect      CommandKind = "select"
	CommandName        CommandKind = "name"
	CommandDescription CommandKind = "description"
	CommandIssue       CommandKind = "issue"
	CommandRotate      CommandKind = "rotate"
	CommandRevoke      CommandKind = "revoke"
	CommandArchive     CommandKind = "archive"
	CommandUnarchive   CommandKind = "unarchive"
	CommandPublish     CommandKind = "publish"
	CommandUnpublish   CommandKind = "unpublish"
	CommandWebhook     CommandKind = "webhook"
	CommandUnwebhook   CommandKind = "unwebhook"
	// The developer-key commands. revokekey is not revoke: that one revokes a
	// BOT credential, and sharing a name would let a typo revoke the wrong thing.
	CommandKeys      CommandKind = "/keys"
	CommandNewKey    CommandKind = "newkey"
	CommandRevokeKey CommandKind = "revokekey"
	CommandConfirm   CommandKind = "confirm"
)

package admin

import "time"

type BotView struct {
	ID                string `json:"id"`
	Name              string `json:"name"`
	Username          string `json:"username"`
	Description       string `json:"description"`
	State             string `json:"state"`
	CredentialState   string `json:"credentialState"`
	CredentialVersion int64  `json:"credentialVersion"`
	MetadataVersion   int64  `json:"metadataVersion"`
}

type Capability struct {
	Enabled                 bool `json:"enabled"`
	CanManageAdministrators bool `json:"canManageAdministrators"`
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

type CommandResult struct {
	Event            Event         `json:"event"`
	Secret           *SecretReveal `json:"secret,omitempty"`
	RecoveryRequired bool          `json:"recoveryRequired,omitempty"`
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
	CommandConfirm     CommandKind = "confirm"
)

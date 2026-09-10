package conformance

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/chaskyapp/botsmith-sdk/go/admin"
)

const (
	testAPISecret = "test-api-secret"
	testBearer    = "test-session-bearer"
)

// ReportedManagementError is what a case asserts on. Each SDK's adapter
// translates its own representation into these fields, exactly as it already
// translates an error code — so a case can state the semantics the contract
// requires without naming any language's error type.
type ReportedManagementError struct {
	ManagementCode string
	Retryable      bool
	AccessLost     bool
	Message        string
}

// ManagementUnderTest is deliberately separate from BotUnderTest: one polls,
// the other answers calls. Merging them would repeat, one layer up, the mistake
// R-A and R-B in §6 of the contract exist to prevent.
type ManagementUnderTest interface {
	Invoke(ctx context.Context, method string, args map[string]any)
	Results() []any
	Errors() []ReportedManagementError
	Warnings() []string
	// Describe renders the client; a credential must never surface here.
	Describe() string
}

type ManagementFactory func(baseURL string) ManagementUnderTest

type sdkManagement struct {
	client   *admin.Client
	results  []any
	errs     []ReportedManagementError
	warnings []string
}

func NewSDKManagement(baseURL string) ManagementUnderTest {
	client, err := admin.New(admin.Options{
		BaseURL:     baseURL,
		APISecret:   admin.AsPlatformSecret(testAPISecret),
		BearerToken: testBearer,
	})
	if err != nil {
		panic(fmt.Sprintf("conformance: could not build the management client: %s", err))
	}
	return &sdkManagement{client: client}
}

func (m *sdkManagement) Invoke(ctx context.Context, method string, args map[string]any) {
	result, err := m.call(ctx, method, args)
	if err != nil {
		m.errs = append(m.errs, toReportedManagement(err))
		return
	}
	m.results = append(m.results, result)
}

func (m *sdkManagement) call(ctx context.Context, method string, args map[string]any) (any, error) {
	switch method {
	case "capability":
		return m.client.Capability(ctx)
	case "bots":
		return m.client.Bots(ctx, admin.Page{Cursor: str(args["cursor"]), Limit: intOf(args["limit"])})
	case "bot":
		return m.client.Bot(ctx, str(args["id"]))
	case "dialogue":
		return m.client.Dialogue(ctx, admin.Page{Cursor: str(args["cursor"]), Limit: intOf(args["limit"])})
	case "command":
		params := admin.CommandParams{
			Command:          admin.CommandKind(str(args["command"])),
			ExpectedRevision: int64(intOf(args["expectedRevision"])),
			Value:            str(args["value"]),
			BotID:            str(args["botID"]),
			OperationID:      str(args["operationID"]),
		}
		if raw, ok := args["expectedCredentialVersion"]; ok && raw != nil {
			version := int64(intOf(raw))
			params.ExpectedCredentialVersion = &version
		}
		return m.client.Command(ctx, params)
	case "createBot":
		return m.client.CreateBot(ctx, admin.CreateBotParams{
			Name:     str(args["name"]),
			Username: str(args["username"]),
		})
	case "grant":
		return m.client.Grant(ctx, str(args["targetId"]), admin.GrantParams{
			Enabled:          args["enabled"] == true,
			ExpectedRevision: int64(intOf(args["expectedRevision"])),
		})
	default:
		return nil, fmt.Errorf("unknown management method: %s", method)
	}
}

func (m *sdkManagement) Results() []any                     { return m.results }
func (m *sdkManagement) Errors() []ReportedManagementError  { return m.errs }
func (m *sdkManagement) Warnings() []string                 { return m.warnings }
func (m *sdkManagement) Describe() string {
	return fmt.Sprintf("%v %+v", m.client, m.client)
}

func toReportedManagement(err error) ReportedManagementError {
	var failure *admin.Error
	if errors.As(err, &failure) {
		return ReportedManagementError{
			ManagementCode: string(failure.Code),
			Retryable:      failure.Retryable(),
			AccessLost:     failure.AccessLost(),
			Message:        failure.Error(),
		}
	}
	return ReportedManagementError{Message: err.Error()}
}

// runManagementCase invokes methods in order; nothing polls, so there is no
// loop to wait on and no steady state. The exchange list and every matcher work
// exactly as they do for the runtime — that reuse is why both kinds share one
// format.
func runManagementCase(c Case, factory ManagementFactory) []Failure {
	fake := NewFakeServer(c.Exchanges)
	defer fake.Close()

	client := factory(fake.BaseURL())
	ctx := context.Background()
	for _, call := range c.Calls {
		client.Invoke(ctx, call.Method, call.Args)
	}

	failures := checkRequests(c, fake)
	return append(failures, checkManagementAssertions(c, client)...)
}

func checkManagementAssertions(c Case, client ManagementUnderTest) []Failure {
	var failures []Failure
	errs := client.Errors()

	for i, want := range c.Assert.ErrorsReported {
		if i >= len(errs) {
			failures = append(failures, Failure{
				Where:  "assert.errorsReported",
				Detail: fmt.Sprintf("expected an error at position %d, none was reported", i),
			})
			continue
		}
		got := errs[i]
		if want.ManagementCode != "" && got.ManagementCode != want.ManagementCode {
			failures = append(failures, Failure{
				Where:  "assert.errorsReported",
				Detail: fmt.Sprintf("error #%d: expected code %s, got %s", i+1, want.ManagementCode, got.ManagementCode),
			})
		}
		if want.Retryable != nil && *want.Retryable != got.Retryable {
			failures = append(failures, Failure{
				Where:  "assert.errorsReported",
				Detail: fmt.Sprintf("error #%d: expected retryable=%t, got %t", i+1, *want.Retryable, got.Retryable),
			})
		}
		if want.AccessLost != nil && *want.AccessLost != got.AccessLost {
			failures = append(failures, Failure{
				Where:  "assert.errorsReported",
				Detail: fmt.Sprintf("error #%d: expected accessLost=%t, got %t", i+1, *want.AccessLost, got.AccessLost),
			})
		}
	}
	if len(c.Assert.ErrorsReported) == 0 && len(errs) > 0 {
		codes := make([]string, 0, len(errs))
		for _, e := range errs {
			codes = append(codes, orDefault(e.ManagementCode, e.Message))
		}
		failures = append(failures, Failure{
			Where:  "assert.errorsReported",
			Detail: "expected no errors, got " + strings.Join(codes, ", "),
		})
	}

	if want := c.Assert.CreatedBotID; want != "" {
		found := false
		for _, result := range client.Results() {
			if created, ok := result.(admin.CreateBotResult); ok && created.BotID == want {
				found = true
				break
			}
		}
		if !found {
			failures = append(failures, Failure{
				Where:  "assert.createdBotId",
				Detail: fmt.Sprintf("expected the facade to report creating %s", want),
			})
		}
	}

	if secret := c.Assert.SecretReturnedOnce; secret != "" {
		encoded, _ := json.Marshal(client.Results())
		if !strings.Contains(string(encoded), secret) {
			failures = append(failures, Failure{
				Where:  "assert.secretReturnedOnce",
				Detail: "the revealed token never reached the caller",
			})
		}
		// The one response carrying a live token is response-only by the
		// server's own design. If the SDK lets it reach a log line, an error, or
		// its own representation, it undoes the only protection built for it.
		errorsEncoded, _ := json.Marshal(client.Errors())
		warningsEncoded, _ := json.Marshal(client.Warnings())
		places := map[string]string{
			"errors":   string(errorsEncoded),
			"warnings": string(warningsEncoded),
			"repr":     client.Describe(),
		}
		for _, place := range c.Assert.SecretNotIn {
			if strings.Contains(places[place], secret) {
				failures = append(failures, Failure{
					Where:  "assert.secretNotIn",
					Detail: fmt.Sprintf("the revealed token LEAKED into %s; it must reach the return value only", place),
				})
			}
		}
	}
	return failures
}

func str(value any) string {
	text, _ := value.(string)
	return text
}

func intOf(value any) int {
	switch typed := value.(type) {
	case float64:
		return int(typed)
	case int:
		return typed
	default:
		return 0
	}
}

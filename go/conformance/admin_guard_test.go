package conformance

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// brokenManagement makes the single mistake m1 exists to catch: sending null
// for an unset optional instead of omitting the field. That is what a JSON
// serialiser does by default in most languages, and the server answers 400
// INVALID_INPUT.
type brokenManagement struct {
	baseURL string
	results []any
	errs    []ReportedManagementError
}

func (b *brokenManagement) Invoke(ctx context.Context, method string, args map[string]any) {
	body := map[string]any{
		"operationID":               "00000000-0000-4000-8000-000000000000",
		"expectedRevision":          args["expectedRevision"],
		"command":                   args["command"],
		"value":                     args["value"],
		"botID":                     args["botID"],
		"expectedCredentialVersion": args["expectedCredentialVersion"],
	}
	encoded, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, b.baseURL+"/bot-management/commands", strings.NewReader(string(encoded)))
	if err != nil {
		b.errs = append(b.errs, ReportedManagementError{Message: err.Error()})
		return
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		b.errs = append(b.errs, ReportedManagementError{Message: err.Error()})
		return
	}
	defer resp.Body.Close()
	b.results = append(b.results, nil)
}

func (b *brokenManagement) Results() []any                    { return b.results }
func (b *brokenManagement) Errors() []ReportedManagementError { return b.errs }
func (b *brokenManagement) Warnings() []string                { return nil }
func (b *brokenManagement) Describe() string                  { return "brokenManagement" }

// TestManagementRunnerDetectsANullOptional keeps the management half honest.
//
// A runner that has never failed a case is not a tested runner: it might report
// PASS because it checks nothing. m1 must fail against a client that sends
// nulls where the contract requires omission.
func TestManagementRunnerDetectsANullOptional(t *testing.T) {
	cases, err := LoadCases(casesDir)
	if err != nil {
		t.Fatalf("could not load cases: %s", err)
	}
	var target Case
	for _, c := range cases {
		if c.ID == "m1-omits-optionals-never-sends-null" {
			target = c
			break
		}
	}
	if target.ID == "" {
		t.Fatal("m1-omits-optionals-never-sends-null is missing; this guard needs it")
	}

	failures := RunManagementCase(target, func(baseURL string) ManagementUnderTest {
		return &brokenManagement{baseURL: baseURL}
	})
	if len(failures) == 0 {
		t.Fatal("the runner passed a client that sends null for every optional; it is not checking bodies")
	}
}

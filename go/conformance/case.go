// Package conformance runs the shared conformance cases against the Go SDK.
//
// The cases in ../../conformance/cases are data shared by all three SDKs; only
// this runner is Go's. Where the TypeScript runner is a CLI, this is a test,
// because that is what a Go developer runs. Same cases, same verdicts,
// different shape — §3 of ../../docs/01-organization.md.
package conformance

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
)

type ExpectedRequest struct {
	Method  string            `json:"method"`
	Path    string            `json:"path"`
	Body    map[string]any    `json:"body"`
	Headers map[string]string `json:"headers"`
}

type CannedResponse struct {
	Status         int    `json:"status"`
	Body           any    `json:"body"`
	TransportError string `json:"transportError"`
	DelayMs        int    `json:"delayMs"`
}

type Exchange struct {
	Expect  ExpectedRequest `json:"expect"`
	Respond CannedResponse  `json:"respond"`
	// Repeat marks the last exchange as the idle steady state: a live bot keeps
	// long-polling, and those polls are correct behaviour rather than surplus.
	Repeat bool `json:"repeat"`
}

type HandlerSpec struct {
	Kind             string  `json:"kind"`
	ThrowOnUpdateIds []int64 `json:"throwOnUpdateIds"`
	ReplyText        string  `json:"replyText"`
}

type Assertions struct {
	BotStopped  *bool `json:"botStopped"`
	HandlerRuns []struct {
		UpdateID int64 `json:"updateId"`
		Times    int   `json:"times"`
	} `json:"handlerRuns"`
	ErrorsReported []struct {
		Code        *int   `json:"code"`
		NotContains string `json:"notContains"`
	} `json:"errorsReported"`
	Warnings []struct {
		Contains string `json:"contains"`
	} `json:"warnings"`
}

type Case struct {
	ID              string `json:"id"`
	ContractVersion string `json:"contractVersion"`
	Guarantee       string `json:"guarantee"`
	Title           string `json:"title"`
	Why             string `json:"why"`
	Bot             struct {
		Transport string `json:"transport"`
		Options   struct {
			Limit          int `json:"limit"`
			TimeoutSeconds int `json:"timeoutSeconds"`
		} `json:"options"`
		Handler HandlerSpec `json:"handler"`
	} `json:"bot"`
	Exchanges []Exchange `json:"exchanges"`
	Assert    Assertions `json:"assert"`
	Run       struct {
		TimeoutMs int `json:"timeoutMs"`
	} `json:"run"`
}

// ObservedRequest is a request as the fake actually saw it.
type ObservedRequest struct {
	Method  string
	Path    string
	Headers map[string]string
	Body    any
}

// LoadCases reads every case, sorted, so failures are reported in a stable
// order across runs and across languages.
func LoadCases(dir string) ([]Case, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() && filepath.Ext(e.Name()) == ".json" {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)

	cases := make([]Case, 0, len(names))
	for _, name := range names {
		raw, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			return nil, err
		}
		var c Case
		if err := json.Unmarshal(raw, &c); err != nil {
			return nil, err
		}
		cases = append(cases, c)
	}
	return cases, nil
}

package conformance

import (
	"path/filepath"
	"testing"
)

// casesDir is outside this module, and Go's test cache does not hash it. Run
// with -count=1 whenever a case changes, or a stale `ok (cached)` will report a
// pass for a case that never ran. See go/README.md.
const casesDir = "../../conformance/cases"

func TestConformance(t *testing.T) {
	cases, err := LoadCases(casesDir)
	if err != nil {
		t.Fatalf("could not load cases from %s: %s", filepath.Clean(casesDir), err)
	}
	if len(cases) == 0 {
		t.Fatalf("no cases found in %s", filepath.Clean(casesDir))
	}

	for _, c := range cases {
		t.Run(c.ID, func(t *testing.T) {
			t.Parallel()
			failures := RunCase(c, NewSDKBot)
			if len(failures) == 0 {
				return
			}
			t.Errorf("%s — %s", c.Guarantee, c.Title)
			for _, f := range failures {
				t.Errorf("  · %s", f)
			}
			// Printed only on failure: at the moment someone is deciding whether
			// this case is worth keeping, they should be reading what breaks in
			// production if it goes.
			t.Errorf("  why: %s", c.Why)
		})
	}
}

// TestRunnerDetectsAMismatch keeps the suite honest.
//
// A runner that has never failed a case is not a tested runner: it might report
// PASS because it checks nothing. The TypeScript side proves this with a
// deliberately naive bot; here it is cheaper to take a passing case, make one
// expectation impossible, and require the runner to notice.
func TestRunnerDetectsAMismatch(t *testing.T) {
	cases, err := LoadCases(casesDir)
	if err != nil {
		t.Fatalf("could not load cases: %s", err)
	}

	var target Case
	for _, c := range cases {
		if c.ID == "g2-offset-advances-when-handler-throws" {
			target = c
			break
		}
	}
	if target.ID == "" {
		t.Fatal("g2-offset-advances-when-handler-throws is missing; this guard needs it")
	}

	// The first poll cannot possibly carry offset 999.
	target.Exchanges[0].Expect.Body["offset"] = float64(999)

	if failures := RunCase(target, NewSDKBot); len(failures) == 0 {
		t.Fatal("the runner passed a case whose first expectation was impossible; it is not checking requests")
	}
}

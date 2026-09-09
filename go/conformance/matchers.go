package conformance

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

// Captures holds $capture:name values for one case. It is what makes G4
// expressible: a fresh Idempotency-Key per logical message, the same one on
// that message's retry.
type Captures map[string]string

var matcherPattern = regexp.MustCompile(`^\$(any|absent|capture|same|notSame)(?::(.+))?$`)

func isEmpty(v any) bool {
	if v == nil {
		return true
	}
	s, ok := v.(string)
	return ok && s == ""
}

// matchValue reports an empty string on success or a reason on failure.
//
// $absent is NOT handled here: absence is a property of the parent object, so
// matchPartial deals with it before ever reaching a value.
func matchValue(expected, actual any, captures Captures, path string) string {
	if s, ok := expected.(string); ok {
		if m := matcherPattern.FindStringSubmatch(s); m != nil {
			kind, name := m[1], m[2]
			switch kind {
			case "any":
				if isEmpty(actual) {
					return fmt.Sprintf("%s: expected any non-empty value, got %s", path, format(actual))
				}
				return ""
			case "absent":
				return fmt.Sprintf("%s: $absent is only valid as an object field, not as a value", path)
			case "capture":
				if isEmpty(actual) {
					return fmt.Sprintf("%s: cannot capture an empty value", path)
				}
				got := format(actual)
				if prior, seen := captures[name]; seen && prior != got {
					return fmt.Sprintf("%s: %s was already captured as %s, now saw %s", path, name, prior, got)
				}
				captures[name] = got
				return ""
			case "same":
				prior, seen := captures[name]
				if !seen {
					return fmt.Sprintf("%s: $same:%s used before %s was captured", path, name, name)
				}
				if format(actual) != prior {
					return fmt.Sprintf("%s: expected the captured %s (%s), got %s", path, name, prior, format(actual))
				}
				return ""
			case "notSame":
				prior, seen := captures[name]
				if !seen {
					return fmt.Sprintf("%s: $notSame:%s used before %s was captured", path, name, name)
				}
				if isEmpty(actual) {
					return fmt.Sprintf("%s: expected a non-empty value differing from %s, got %s", path, name, format(actual))
				}
				if format(actual) == prior {
					return fmt.Sprintf("%s: expected a value DIFFERENT from %s, but got the same one (%s)", path, name, format(actual))
				}
				return ""
			}
		}
	}

	switch want := expected.(type) {
	case map[string]any:
		return matchPartial(want, actual, captures, path)
	case []any:
		got, ok := actual.([]any)
		if !ok {
			return fmt.Sprintf("%s: expected an array, got %s", path, format(actual))
		}
		if len(want) != len(got) {
			return fmt.Sprintf("%s: expected %d elements, got %d", path, len(want), len(got))
		}
		for i := range want {
			if reason := matchValue(want[i], got[i], captures, fmt.Sprintf("%s[%d]", path, i)); reason != "" {
				return reason
			}
		}
		return ""
	}

	if format(expected) != format(actual) {
		return fmt.Sprintf("%s: expected %s, got %s", path, format(expected), format(actual))
	}
	return ""
}

// matchPartial compares only the declared fields, ignoring the rest. That is
// deliberate: a case should pin what it is about and stay silent on everything
// else, so unrelated payload growth does not break every case at once.
func matchPartial(expected map[string]any, actual any, captures Captures, path string) string {
	target, ok := actual.(map[string]any)
	if !ok {
		return fmt.Sprintf("%s: expected an object, got %s", path, format(actual))
	}
	keys := sortedKeys(expected)
	for _, key := range keys {
		at := key
		if path != "" {
			at = path + "." + key
		}
		want := expected[key]
		if s, isString := want.(string); isString && s == "$absent" {
			// Presence of the KEY is the failure. A decoded JSON null arrives
			// here as nil, and treating that as absent would accept the exact
			// mistake m1 exists to catch.
			if got, present := target[key]; present {
				return fmt.Sprintf("%s: expected the field to be absent, but it was %s", at, format(got))
			}
			continue
		}
		got, present := target[key]
		if !present {
			return at + ": missing"
		}
		if reason := matchValue(want, got, captures, at); reason != "" {
			return reason
		}
	}
	return ""
}

// matchHeaders compares case-insensitively by name.
func matchHeaders(expected map[string]string, actual map[string]string, captures Captures) string {
	lowered := map[string]any{}
	for k, v := range actual {
		lowered[strings.ToLower(k)] = v
	}
	wanted := map[string]any{}
	for k, v := range expected {
		wanted[strings.ToLower(k)] = v
	}
	return matchPartial(wanted, lowered, captures, "headers")
}

// format renders a value the same way regardless of how JSON decoded it, so a
// number that arrived as float64 compares equal to the same number in a case.
func format(v any) string {
	switch value := v.(type) {
	case nil:
		return "null"
	case string:
		return value
	case float64:
		if value == float64(int64(value)) {
			return fmt.Sprintf("%d", int64(value))
		}
		return fmt.Sprintf("%v", value)
	default:
		encoded, err := json.Marshal(value)
		if err != nil {
			return fmt.Sprintf("%v", value)
		}
		return string(encoded)
	}
}

func sortedKeys(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	// Deterministic order: Go randomises map iteration, and a runner whose
	// failure list reorders between runs is miserable to read.
	for i := 1; i < len(keys); i++ {
		for j := i; j > 0 && keys[j] < keys[j-1]; j-- {
			keys[j], keys[j-1] = keys[j-1], keys[j]
		}
	}
	return keys
}

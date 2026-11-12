package protocol

import (
	"bytes"
	"encoding/json"
	"testing"
)

// The guest's result envelope is the only place the wire shape is defined. A
// duplicate JSON tag makes encoding/json drop both fields, which is silent on
// the Go side and only shows up as a missing field in another language. These
// tests pin the shape per operation and refuse duplicate top-level keys.

func decodeResult(t *testing.T, result Result) map[string]any {
	t.Helper()
	raw, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("unmarshal %s: %v", raw, err)
	}
	return decoded
}

func TestExecResultCarriesStdoutAndStderrTruncation(t *testing.T) {
	decoded := decodeResult(t, Result{
		Op:        OpExec,
		Truncated: Truncated{Stdout: true, Stderr: false},
	})
	got, ok := decoded["truncated"].(map[string]any)
	if !ok {
		t.Fatalf("truncated: want object, got %#v", decoded["truncated"])
	}
	if got["stdout"] != true || got["stderr"] != false {
		t.Fatalf("truncated: got %#v", got)
	}
}

func TestHTTPResultCarriesBodyTruncation(t *testing.T) {
	decoded := decodeResult(t, Result{Op: OpHTTP, Truncated: true})
	if decoded["truncated"] != true {
		t.Fatalf("truncated: want true, got %#v", decoded["truncated"])
	}
}

func TestTruncatedIsOmittedWhenUnset(t *testing.T) {
	decoded := decodeResult(t, Result{Op: OpFileGet})
	if _, ok := decoded["truncated"]; ok {
		t.Fatalf("truncated must be omitted for file results: %#v", decoded)
	}
}

func TestResultHasNoDuplicateTopLevelKeys(t *testing.T) {
	for _, result := range []Result{
		{Op: OpExec, Truncated: Truncated{Stdout: true}},
		{Op: OpHTTP, Truncated: true},
		{Op: OpFileGet},
	} {
		raw, err := json.Marshal(result)
		if err != nil {
			t.Fatalf("marshal %s: %v", result.Op, err)
		}
		seen := map[string]bool{}
		for _, key := range topLevelKeys(t, raw) {
			if seen[key] {
				t.Fatalf("%s: duplicate top-level key %q in %s", result.Op, key, raw)
			}
			seen[key] = true
		}
	}
}

func topLevelKeys(t *testing.T, raw []byte) []string {
	t.Helper()
	decoder := json.NewDecoder(bytes.NewReader(raw))
	token, err := decoder.Token()
	if err != nil {
		t.Fatalf("read object: %v", err)
	}
	if token != json.Delim('{') {
		t.Fatalf("want object, got %v", token)
	}
	var keys []string
	for decoder.More() {
		key, err := decoder.Token()
		if err != nil {
			t.Fatalf("read key: %v", err)
		}
		keys = append(keys, key.(string))
		var value any
		if err := decoder.Decode(&value); err != nil {
			t.Fatalf("read value for %v: %v", key, err)
		}
	}
	return keys
}

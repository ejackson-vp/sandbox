package canonical_test

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/x402s/sandbox/guest/internal/canonical"
)

// The fixture is shared with tests/unit/canonical-vectors.test.ts. This package
// lives at guest/internal/canonical, so the repo root is three levels up.
const fixturePath = "../../../tests/fixtures/canonical-vectors.json"

type vector struct {
	Name     string          `json:"name"`
	Input    json.RawMessage `json:"input"`
	Expected string          `json:"expected"`
}

type fixture struct {
	Vectors []vector `json:"vectors"`
}

func loadFixture(t *testing.T) fixture {
	t.Helper()
	raw, err := os.ReadFile(filepath.FromSlash(fixturePath))
	if err != nil {
		t.Fatalf("read fixture %s: %v", fixturePath, err)
	}
	var f fixture
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("decode fixture %s: %v", fixturePath, err)
	}
	if len(f.Vectors) < 50 {
		t.Fatalf("fixture has %d vectors, expected at least 50", len(f.Vectors))
	}
	return f
}

// TestConformanceVectors replays every shared vector through Marshal and compares
// the bytes to the expected canonical string.
func TestConformanceVectors(t *testing.T) {
	f := loadFixture(t)
	seen := make(map[string]bool, len(f.Vectors))
	for _, v := range f.Vectors {
		if seen[v.Name] {
			t.Fatalf("duplicate vector name %q", v.Name)
		}
		seen[v.Name] = true
		t.Run(v.Name, func(t *testing.T) {
			// Numbers decode as float64 on purpose: JS has one number type and
			// Go decodes JSON into float64, so a double is what both sides see.
			// json.Number is deliberately not used here; Marshal does not accept
			// it, and preserving the literal would test a decoder difference
			// rather than the encoder. The fixture documents this: the 2^53+1
			// vector pins the double the literal collapses to.
			var input any
			if err := json.Unmarshal(v.Input, &input); err != nil {
				t.Fatalf("decode input %s: %v", v.Input, err)
			}
			got, err := canonical.Marshal(input)
			if err != nil {
				t.Fatalf("Marshal: %v", err)
			}
			if string(got) != v.Expected {
				t.Errorf("canonical bytes differ\n  input: %s\n   want: %q\n    got: %q\n  want hex: % x\n   got hex: % x",
					v.Input, v.Expected, got, v.Expected, got)
			}
		})
	}
}

// TestMarshalGoTypes covers the encoder branches the JSON fixture cannot reach:
// the fixture only ever produces float64, but callers pass native ints and
// string-typed maps. int64/uint64 values are only safe below 2^53, where they
// agree with a JS double.
func TestMarshalGoTypes(t *testing.T) {
	cases := []struct {
		name string
		in   any
		want string
	}{
		{"int", int(42), "42"},
		{"int32", int32(-7), "-7"},
		{"int64", int64(1750000000000), "1750000000000"},
		{"uint64", uint64(9007199254740991), "9007199254740991"},
		{"float64 integral", float64(2), "2"},
		{"string slice", []string{"b", "a"}, `["b","a"]`},
		{"string map", map[string]string{"b": "2", "a": "1"}, `{"a":"1","b":"2"}`},
		{"nested any", map[string]any{"b": []any{1, "x", nil}, "a": true}, `{"a":true,"b":[1,"x",null]}`},
		{"negative zero", math.Copysign(0, -1), "0"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := canonical.Marshal(tc.in)
			if err != nil {
				t.Fatalf("Marshal(%T): %v", tc.in, err)
			}
			if string(got) != tc.want {
				t.Errorf("Marshal(%T) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}

	if _, err := canonical.Marshal(struct{ A int }{1}); err == nil {
		t.Fatal("expected an error for an unsupported struct type")
	} else if !strings.Contains(err.Error(), "unsupported type") {
		t.Fatalf("unexpected error: %v", err)
	}
}

package main

import "testing"

func TestCheckWarmClaimImage(t *testing.T) {
	cases := []struct {
		name   string
		own    string
		claim  string
		wantOK bool
	}{
		{name: "matching digest", own: "sha256:aa", claim: "sha256:aa", wantOK: true},
		{name: "new image claim on old guest", own: "sha256:aa", claim: "sha256:bb"},
		{name: "empty local digest", own: "", claim: "", wantOK: true},
		{name: "missing guest digest", own: "", claim: "sha256:bb"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := checkWarmClaimImage(tc.own, tc.claim)
			if tc.wantOK && err != nil {
				t.Fatalf("expected match, got %v", err)
			}
			if !tc.wantOK && err == nil {
				t.Fatal("expected a mismatch error")
			}
		})
	}
}

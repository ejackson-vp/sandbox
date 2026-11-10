package attest

import "testing"

func TestClaimsForRuntimeProfile(t *testing.T) {
	claims := claimsFor(Config{RuntimeProfile: "python", RuntimeVersion: "3.12"}, "measurement")
	runtime, ok := claims["runtime"].(map[string]any)
	if !ok {
		t.Fatalf("runtime claim missing: %#v", claims)
	}
	if runtime["name"] != "python" || runtime["version"] != "3.12" {
		t.Fatalf("unexpected runtime claim: %#v", runtime)
	}
}

func TestClaimsForLegacySessionHasNoRuntime(t *testing.T) {
	claims := claimsFor(Config{}, "measurement")
	if _, ok := claims["runtime"]; ok {
		t.Fatal("legacy session should not claim a runtime profile")
	}
}

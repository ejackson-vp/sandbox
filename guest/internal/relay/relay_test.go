package relay

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/coder/websocket"

	"github.com/x402s/sandbox/guest/internal/protocol"
)

// every dispatched verb, spelled independently of the advertised list so a verb
// added to the supervisor without a capability is caught here.
var dispatchedVerbs = []string{
	"exec",
	"file.put",
	"file.get",
	"file.list",
	"file.stat",
	"service.start",
	"service.stop",
	"service.list",
	"http.request",
	"http.stream.open",
	"http.stream.read",
	"http.stream.close",
	"ws.open",
	"ws.read",
	"ws.send",
	"ws.close",
	"transfer.init",
	"transfer.chunk",
	"transfer.complete",
	"transfer.status",
	"transfer.read",
	"transfer.cancel",
}

func TestHelloFrameCarriesProtocolVersionAndCapabilities(t *testing.T) {
	evidence := map[string]any{"v": 1, "sessionId": "sbx_test"}
	frame := helloFrame(evidence)

	if frame["type"] != "hello" {
		t.Fatalf("type = %v, want hello", frame["type"])
	}
	if frame["protocolVersion"] != ProtocolVersion {
		t.Fatalf("protocolVersion = %v, want %d", frame["protocolVersion"], ProtocolVersion)
	}
	if ProtocolVersion <= 0 {
		t.Fatalf("ProtocolVersion must be positive, got %d", ProtocolVersion)
	}
	caps, ok := frame["capabilities"].([]string)
	if !ok {
		t.Fatalf("capabilities is %T, want []string", frame["capabilities"])
	}
	if len(caps) != len(dispatchedVerbs) {
		t.Fatalf("advertised %d capabilities, guest dispatches %d verbs", len(caps), len(dispatchedVerbs))
	}
	advertised := make(map[string]bool, len(caps))
	for _, capability := range caps {
		advertised[capability] = true
	}
	for _, verb := range dispatchedVerbs {
		if !advertised[verb] {
			t.Errorf("capability %q is dispatched by the guest but not advertised", verb)
		}
	}
	if !reflect.DeepEqual(frame["evidence"], evidence) {
		t.Fatalf("evidence = %v, want %v", frame["evidence"], evidence)
	}
}

// The relay parses JSON, not Go values: pin the wire shape the controller reads.
func TestHelloFrameMarshalsMetadata(t *testing.T) {
	raw, err := json.Marshal(helloFrame(map[string]any{"v": 1}))
	if err != nil {
		t.Fatalf("marshal hello: %v", err)
	}
	var decoded struct {
		Type            string         `json:"type"`
		ProtocolVersion int            `json:"protocolVersion"`
		Capabilities    []string       `json:"capabilities"`
		Evidence        map[string]any `json:"evidence"`
	}
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("unmarshal hello: %v", err)
	}
	if decoded.Type != "hello" {
		t.Fatalf("type = %q, want hello", decoded.Type)
	}
	if decoded.ProtocolVersion != ProtocolVersion {
		t.Fatalf("protocolVersion = %d, want %d", decoded.ProtocolVersion, ProtocolVersion)
	}
	if len(decoded.Capabilities) == 0 {
		t.Fatal("capabilities missing from serialized hello")
	}
	found := false
	for _, capability := range decoded.Capabilities {
		if capability == protocol.OpExec {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("capabilities %v do not include %q", decoded.Capabilities, protocol.OpExec)
	}
	if decoded.Evidence["v"] == nil {
		t.Fatal("evidence lost in serialized hello")
	}
}

// A refused handshake must be classifiable: 401 means the guest token is not
// (and will never be) accepted; the rest are transient and the supervisor keeps
// reconnecting until the lease ends.
func TestDialOnceClassifiesHandshakeRefusals(t *testing.T) {
	cases := map[int]bool{
		401: true,
		404: false, // not re-registered yet
		409: false, // a stale socket the relay still believes in
		421: false, // landed on the wrong shard
	}
	for status, permanent := range cases {
		status := status
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(status)
		}))
		url := "ws" + strings.TrimPrefix(server.URL, "http") + "/guest?session=sbx_test&token=t"
		_, err := DialOnce(context.Background(), url)
		server.Close()
		var statusErr *StatusError
		if !errors.As(err, &statusErr) {
			t.Fatalf("status %d: err = %v, want *StatusError", status, err)
		}
		if statusErr.Status != status {
			t.Fatalf("status %d reported as %d", status, statusErr.Status)
		}
		if statusErr.Permanent() != permanent {
			t.Fatalf("status %d permanent = %v, want %v", status, statusErr.Permanent(), permanent)
		}
	}
}

func TestDialOnceAcceptsAnUpgradedGuestConnection(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		_ = conn.Close(websocket.StatusNormalClosure, "done")
	}))
	defer server.Close()

	url := "ws" + strings.TrimPrefix(server.URL, "http") + "/guest?session=sbx_test&token=t"
	client, err := DialOnce(context.Background(), url)
	if err != nil {
		t.Fatalf("DialOnce: %v", err)
	}
	client.Close()
}

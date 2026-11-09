package main

import (
	"encoding/json"
	"testing"

	"github.com/x402s/sandbox/guest/internal/envelope"
	"github.com/x402s/sandbox/guest/internal/protocol"
	"github.com/x402s/sandbox/guest/internal/relay"
)

// FuzzSupervisorDecrypt drives the gate every relay frame passes through
// before dispatch: base64 envelope open, JSON decode, and the session
// binding checks (v, sessionId, clientNonce, requestId). It must never panic,
// must never hand back a request whose binding does not match the frame, and
// must keep its error text bounded.
//
// With bind=false the raw fuzz bytes are sealed verbatim, so arbitrary JSON
// and non-JSON payloads reach json.Unmarshal. With bind=true the payload is a
// correctly bound request whose op is attacker-controlled, which exercises the
// accept path that feeds the dispatch switch.
func FuzzSupervisorDecrypt(f *testing.F) {
	keys, err := envelope.GenerateKeyPair()
	if err != nil {
		f.Fatalf("generate key pair: %v", err)
	}
	sup := &supervisor{
		keys:        keys,
		sessionID:   "sbx_fuzz_session",
		clientNonce: "fuzz-client-nonce",
	}

	bound := func(op string) []byte {
		plain, err := json.Marshal(protocol.Request{
			V: 2, SessionID: sup.sessionID, ClientNonce: sup.clientNonce,
			RequestID: "req-1", Op: op,
		})
		if err != nil {
			f.Fatalf("marshal bound request: %v", err)
		}
		return plain
	}

	f.Add(bound(protocol.OpExec), true)
	f.Add(bound("not.an.operation"), true)
	f.Add([]byte(`{"v":2}`), false)
	f.Add([]byte(`{}`), false)
	f.Add([]byte(`null`), false)
	f.Add([]byte(`{"v":2,`), false)
	f.Add([]byte("not json at all"), false)

	f.Fuzz(func(t *testing.T, payload []byte, bind bool) {
		if bind {
			var req protocol.Request
			if err := json.Unmarshal(payload, &req); err != nil || req.Op == "" {
				req = protocol.Request{
					V: 2, SessionID: sup.sessionID, ClientNonce: sup.clientNonce,
					RequestID: "req-1", Op: string(payload),
				}
			}
			req.V = 2
			req.SessionID = sup.sessionID
			req.ClientNonce = sup.clientNonce
			req.RequestID = "req-1"
			payload, _ = json.Marshal(req)
		}

		sealed, err := envelope.Seal(keys.Public, payload)
		if err != nil {
			t.Fatalf("seal payload: %v", err)
		}
		frame := &relay.Frame{Type: "request", ID: "req-1", Envelope: sealed}

		req, err := sup.decrypt(frame)
		if err != nil {
			if req != nil {
				t.Fatal("decrypt returned a request together with an error")
			}
			if msg := err.Error(); len(msg) == 0 || len(msg) > 256 {
				t.Fatalf("unbounded error text: %d bytes", len(msg))
			}
			return
		}
		if req.V != 2 {
			t.Fatalf("accepted request with v=%d", req.V)
		}
		if req.SessionID != sup.sessionID || req.ClientNonce != sup.clientNonce {
			t.Fatal("accepted a request bound to a different session")
		}
		if req.RequestID != frame.ID {
			t.Fatalf("accepted request id %q for frame %q", req.RequestID, frame.ID)
		}
		if len(req.RequestID) == 0 || len(req.RequestID) > 128 {
			t.Fatalf("accepted request id of %d bytes", len(req.RequestID))
		}
	})
}

// FuzzFrameDecode feeds arbitrary relay control frames through the guest's
// JSON decoder. Frame parsing happens before any authentication, so a
// truncated or hostile frame must yield a zero-valued frame or an error, never
// a panic.
func FuzzFrameDecode(f *testing.F) {
	f.Add([]byte(`{"type":"request","id":"req-1","envelope":"AAAA","deadlineMs":1}`))
	f.Add([]byte(`{"type":"claim","claim":{"sessionId":"sbx_1"}}`))
	f.Add([]byte(`{"type":"shutdown","reason":"lease ended"}`))
	f.Add([]byte(`{}`))
	f.Add([]byte(``))
	f.Add([]byte(`{"type":`))

	f.Fuzz(func(t *testing.T, data []byte) {
		var frame relay.Frame
		err := json.Unmarshal(data, &frame)
		if err != nil {
			return
		}
		if frame.Claim != nil && len(frame.Claim.SessionID) > 1<<20 {
			t.Fatalf("claim session id is unbounded: %d bytes", len(frame.Claim.SessionID))
		}
	})
}

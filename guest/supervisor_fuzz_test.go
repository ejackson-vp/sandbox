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

// FuzzFrameDecode drives the guest's inbound frame parser and the pre-auth
// dispatch decision. Frame parsing happens before any authentication, so a
// truncated or hostile frame must decode to an error, or to a frame the read
// loop ignores, and must never panic or be dispatched.
//
// It calls the two functions the supervisor's read loop actually uses,
// relay.DecodeFrame and frameActionFor, rather than a re-implementation: a
// target that only did json.Unmarshal measured the standard library and reached
// no guest statement at all.
func FuzzFrameDecode(f *testing.F) {
	f.Add([]byte(`{"type":"request","id":"req-1","envelope":"AAAA","deadlineMs":1}`))
	f.Add([]byte(`{"type":"request","id":"","envelope":""}`))
	f.Add([]byte(`{"type":"status","activeRequestId":"","epoch":2}`))
	f.Add([]byte(`{"type":"claim","claim":{"sessionId":"sbx_1"}}`))
	f.Add([]byte(`{"type":"cancel","id":""}`))
	f.Add([]byte(`{"type":"shutdown","reason":"lease ended"}`))
	f.Add([]byte(`{}`))
	f.Add([]byte(``))
	f.Add([]byte(`{"type":`))

	f.Fuzz(func(t *testing.T, data []byte) {
		frame, err := relay.DecodeFrame(data)
		if err != nil {
			// A rejected frame must not come back half-populated, or a caller
			// that checked the error loosely would act on it anyway.
			if frame != nil {
				t.Fatal("decode returned a frame together with an error")
			}
			return
		}
		switch frameActionFor(frame) {
		case actionRequest:
			// The read loop hands this frame to handleRequest, which decrypts
			// before it executes anything. An empty id or envelope can never be
			// answered or decrypted, so it must not reach that point.
			if frame.ID == "" || frame.Envelope == "" {
				t.Fatalf("dispatched a request with id=%q and %d-byte envelope", frame.ID, len(frame.Envelope))
			}
		case actionCancel:
			if frame.ID == "" {
				t.Fatal("dispatched a cancel with no request id")
			}
		}
		if frame.Claim != nil && len(frame.Claim.SessionID) > 1<<20 {
			t.Fatalf("claim session id is unbounded: %d bytes", len(frame.Claim.SessionID))
		}
	})
}

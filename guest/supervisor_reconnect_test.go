package main

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/x402s/sandbox/guest/internal/relay"
)

// A link loss aborts the relay-bound operation and waits for its handler, so a
// reconnect can honestly report an idle slot. It must not need the supervisor's
// own process to exit, and it must not touch anything the guest owns locally.
func TestAbortInflightCancelsEveryOperation(t *testing.T) {
	sup := &supervisor{
		inflight: map[string]context.CancelFunc{},
		slots:    make(chan struct{}, 1),
	}

	cancelled := make(chan string, 2)
	for _, id := range []string{"req-a", "req-b"} {
		id := id
		ctx, cancel := context.WithCancel(context.Background())
		sup.inflight[id] = func() {
			cancel()
			cancelled <- id
		}
		go func() {
			<-ctx.Done()
			sup.handlers.Done()
		}()
		sup.handlers.Add(1)
	}

	done := make(chan struct{})
	go func() {
		sup.abortInflight()
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("abortInflight did not return after its handlers finished")
	}
	close(cancelled)
	seen := map[string]bool{}
	for id := range cancelled {
		seen[id] = true
	}
	if !seen["req-a"] || !seen["req-b"] {
		t.Fatalf("cancelled %v, want both operations", seen)
	}
}

// A replica refusal is retried. Only a guest token the relay will never accept
// ends the session: retrying it until the lease ends would turn an auth failure
// into a slow relay_lost instead of a distinct exit.
func TestStatusErrorOnlyTreatsUnauthorizedAsPermanent(t *testing.T) {
	cases := map[int]bool{
		401: true,
		404: false, // the controller has not re-registered the session yet
		409: false, // a stale guest socket the relay still believes in
		421: false, // a shard mismatch that a retry can resolve
		503: false,
	}
	for status, permanent := range cases {
		err := error(&relay.StatusError{Status: status})
		var statusErr *relay.StatusError
		if !errors.As(err, &statusErr) {
			t.Fatalf("status %d did not stay a StatusError", status)
		}
		if statusErr.Permanent() != permanent {
			t.Fatalf("status %d permanent = %v, want %v", status, statusErr.Permanent(), permanent)
		}
	}
}

// The reconnect loop must not outlive the lease, and must not reconnect early.
func TestReconnectStopsAtLeaseDeadline(t *testing.T) {
	sup := &supervisor{
		sessionID: "sbx_reconnect_test",
		// A URL nothing listens on: every dial fails, so the only way out is the
		// lease deadline or the context.
		relayURL: "ws://127.0.0.1:1/guest?session=sbx_reconnect_test&token=t",
		lease:    time.Now().Add(300 * time.Millisecond),
	}
	started := time.Now()
	_, err := sup.reconnect(context.Background())
	if !errors.Is(err, errLeaseEnded) {
		t.Fatalf("reconnect error = %v, want errLeaseEnded", err)
	}
	elapsed := time.Since(started)
	if elapsed > 3*time.Second {
		t.Fatalf("reconnect ran for %s after the lease ended", elapsed)
	}
}

// A cancelled context (SIGTERM) returns the context error rather than waiting
// for the lease, so shutdown is not delayed by a broken relay.
func TestReconnectHonoursCancellation(t *testing.T) {
	sup := &supervisor{
		sessionID: "sbx_reconnect_cancel",
		relayURL:  "ws://127.0.0.1:1/guest?session=sbx_reconnect_cancel&token=t",
		lease:     time.Now().Add(time.Minute),
	}
	ctx, cancel := context.WithCancel(context.Background())
	var once sync.Once
	go func() {
		time.Sleep(100 * time.Millisecond)
		once.Do(cancel)
	}()
	started := time.Now()
	_, err := sup.reconnect(ctx)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("reconnect error = %v, want context.Canceled", err)
	}
	if time.Since(started) > 3*time.Second {
		t.Fatal("reconnect did not observe cancellation")
	}
}

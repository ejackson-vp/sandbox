package main

import "testing"

// The execution epoch is the restart fence. A guest must reject a request from a
// generation older than one it has already accepted, and must never regress its
// high-water mark based on a stale frame.
func TestAdmitEpochFencesStaleGenerations(t *testing.T) {
	sup := &supervisor{}

	if !sup.admitEpoch(0) {
		t.Fatal("epoch 0 must stay compatible with unfenced callers")
	}
	if sup.epoch != 0 {
		t.Fatalf("epoch 0 changed the high-water mark: %d", sup.epoch)
	}

	if !sup.admitEpoch(3) {
		t.Fatal("a newer epoch must be admitted")
	}
	if sup.epoch != 3 {
		t.Fatalf("high-water mark is %d, want 3", sup.epoch)
	}

	if !sup.admitEpoch(3) {
		t.Fatal("the current epoch must be admitted")
	}
	if sup.admitEpoch(2) {
		t.Fatal("a stale epoch must be rejected")
	}
	if sup.epoch != 3 {
		t.Fatalf("a stale frame regressed the high-water mark: %d", sup.epoch)
	}
}

func TestAdmitEpochAcceptsLegacyZeroAfterFence(t *testing.T) {
	sup := &supervisor{}
	if !sup.admitEpoch(4) {
		t.Fatal("newer epoch rejected")
	}
	// Epoch 0 is "no fence" for the local guest harness; it must not be
	// reinterpreted as an ancient generation and break direct callers.
	if !sup.admitEpoch(0) {
		t.Fatal("epoch 0 should remain admissible")
	}
	if sup.epoch != 4 {
		t.Fatalf("epoch 0 changed the high-water mark: %d", sup.epoch)
	}
}

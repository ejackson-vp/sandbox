/**
 * The controller's wall clock, with jump detection.
 *
 * Deadlines are stored as wall-clock epoch milliseconds because they have to
 * survive a restart (ADR 0006). That is also their weakness: an NTP step, a
 * manual clock change, or a VM resume moves every stored deadline at once. A
 * backward step extends a lease or keeps a stale payment claim alive; a forward
 * step expires a paid session early or lets a live intent be reclaimed. Both
 * fail silently, and neither is reproducible afterwards.
 *
 * This module cannot prevent the step. It makes one visible: the operator
 * assumption is NTP-synchronised clocks with slew (docs/lifecycle.md), and a
 * step larger than the tolerance is logged with the old and new readings so it
 * can be correlated with sessions that ended early or late.
 *
 * Durations deliberately do not come from here. Anything that a wall-clock
 * jump must not shorten (lease renewal, stepping down) measures on a monotonic
 * clock; see `leadership-lease.ts`.
 */
import { log } from "@x402s/shared/runtime";

/**
 * Wall and monotonic time disagree by more than this and the reading is
 * treated as a step rather than drift. Scheduling noise between two readings is
 * milliseconds; a step worth an operator's attention is seconds.
 */
export const CLOCK_JUMP_TOLERANCE_MS = 5_000;

export interface ClockJump {
  /** Reading before the step, epoch milliseconds. */
  from: number;
  /** Reading after the step, epoch milliseconds. */
  to: number;
  /** How far the wall clock moved relative to elapsed monotonic time. */
  deltaMs: number;
  direction: "forward" | "backward";
}

export interface ClockGuardOptions {
  /** Wall clock. Injected so tests can step it. */
  now?: () => number;
  /** Monotonic clock, used only as the reference for elapsed time. */
  monotonic?: () => number;
  toleranceMs?: number;
  /** Override the log line, e.g. to add the sessions the step affects. */
  onJump?: (jump: ClockJump) => void;
}

export class ClockGuard {
  private readonly wall: () => number;
  private readonly mono: () => number;
  private readonly toleranceMs: number;
  private readonly onJump: (jump: ClockJump) => void;
  private lastWall: number | null = null;
  private lastMono: number | null = null;
  private jumps = 0;

  constructor(options: ClockGuardOptions = {}) {
    this.wall = options.now ?? (() => Date.now());
    this.mono = options.monotonic ?? (() => performance.now());
    this.toleranceMs = options.toleranceMs ?? CLOCK_JUMP_TOLERANCE_MS;
    this.onJump =
      options.onJump ??
      ((jump) =>
        log.warn("clock_skew_detected", {
          from: new Date(jump.from).toISOString(),
          to: new Date(jump.to).toISOString(),
          deltaMs: jump.deltaMs,
          direction: jump.direction,
        }));
  }

  /** Wall-clock now, epoch milliseconds. The value deadlines are compared to. */
  now(): number {
    const wall = this.wall();
    const mono = this.mono();
    if (this.lastWall !== null && this.lastMono !== null) {
      const wallDelta = wall - this.lastWall;
      const monoDelta = mono - this.lastMono;
      // A step is wall and monotonic time disagreeing about elapsed time. The
      // sign of the disagreement is the direction: ahead means the wall clock
      // jumped forward, behind means it jumped backward.
      const drift = wallDelta - monoDelta;
      if (Math.abs(drift) > this.toleranceMs) {
        this.jumps += 1;
        this.onJump({
          from: this.lastWall,
          to: wall,
          deltaMs: drift,
          direction: drift > 0 ? "forward" : "backward",
        });
      }
      // Rebase on every reading, step or not: the jump is reported once, and a
      // second step later is reported on its own merits.
    }
    this.lastWall = wall;
    this.lastMono = mono;
    return wall;
  }

  /** Monotonic milliseconds. Use for durations, never for a stored deadline. */
  monotonic(): number {
    return this.mono();
  }

  /** Test and metric hook: how many steps this process has seen. */
  get jumpCount(): number {
    return this.jumps;
  }
}

/**
 * The guest builds its own minimal PATH and never inherits the supervisor's
 * environment (`guest/internal/runner/buildEnv`). That isolation is right for a
 * sandbox, and it means the base image's /usr/bin is the truth inside a real
 * pod.
 *
 * The integration suite is the exception: it runs the guest as a local process,
 * so "node" has to mean the developer's node, which a version manager usually
 * keeps outside the fixed PATH. Commands that need one pass this explicitly
 * rather than the guest loosening its own environment.
 */
export const hostPathEnv: Record<string, string> = process.env.PATH
  ? { PATH: process.env.PATH }
  : {};

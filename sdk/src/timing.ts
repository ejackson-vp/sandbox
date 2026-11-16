/**
 * The one wait the client uses.
 *
 * The polling loops (stream reads, destroy, the busy queue) each need "wait a
 * little and ask again". It lives here rather than in `runtime.ts` so a module
 * that only polls does not import the session runtime to get it.
 */
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

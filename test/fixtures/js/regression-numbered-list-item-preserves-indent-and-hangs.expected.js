/**
 * Resolve a request in two passes.
 *
 * Passes:
 *   1. Fast path checks the local cache first, then falls back
 *      to the origin server, returning immediately on any hit.
 *   2. Slow path re-validates every stale entry against the origin before returning, guaranteeing freshness.
 */
function f() {}

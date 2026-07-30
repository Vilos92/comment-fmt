/**
 * Probe the corridor ahead, score lateral candidates, and produce a nudged pursuit target.
 *
 * Two-tier scoring:
 *   1. Obstacle list (broad phase) → project nearby obstacles into the corridor frame → score overlap/distance.
 *   2. Rapier raycasts along the center corridor and each candidate lane → heavy penalty for hits.
 */
function f() {}

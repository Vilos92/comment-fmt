/**
 * Wires input events to movement, aiming, and firing systems, forwarding validated intents to the
 * simulation each tick, and keeps no authoritative state of its own.
 * @sideEffect Allocates controller state. Per-frame reads entity poses, fires raycasts, and mutates
 * scratch buffers, then broadcasts results.
 */
function createPilot() {}

const HEADER_A_BYTES = 4; // short
const HEADER_B_BYTES = 33; // seq(4) + steering.x/y/z(f32x3) + throttle(4) + isFiring(1) + aimPoint.x/y/z(f32x3)
const HEADER_C_BYTES = 6; // short

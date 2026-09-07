// ═══════════════════════════════════════════════════
// CONFIG — every gameplay number lives here. Tune freely.
// Per-LEVEL data (map bounds, spawn point, patrol waypoints, the
// Shahed's route) lives in levels.js instead — this file is the feel
// of the game, not the shape of any one mission.
// ═══════════════════════════════════════════════════
export const CFG = {
  player: {
    maxSpeed:     55,        // units/sec toward the finger
    accel:        7.0,       // how snappily velocity follows the target
    radius:       1.4,       // collision circle
    blastRadius:  15,        // kill radius of the detonation
    hoverY:       2.3,       // flight altitude
    joyRadius:    85,        // px: joystick range (full deflection = full speed)
    joyDeadzone:  7,         // px: finger within this of the anchor = hover
  },
  enemy: {
    detectRadius: 58,        // acoustic detection — hears you through walls
    burstRounds:  30,        // rounds per burst
    fireDelay:    0.10,      // sec between rounds
    reloadTime:   3.2,       // sec of vulnerability window
    bulletSpeed:  52,
    spreadDeg:    5.5,       // max aim deviation in degrees, either side.
                             // Bell-ish: most rounds land near the aim line,
                             // occasional wider strays. Makes dodging possible
                             // and stops the burst reading as one rigid line.
    speedJitter:  0.3,      // ±10% per-round muzzle velocity variance
    turnRate:     2.6,       // turret radians/sec
    aimTolerance: 0.18,      // must be aimed this close (rad) to fire
    moveSpeed:    15,         // patrol speed
    waypointPause:1.4,       // sec paused at each waypoint
    bodyRadius:   3.0,       // ramming distance — touching the enemy detonates you

    // ── Flee behaviour ──
    // Once it hears you inside fleeRadius it stops patrolling and backs
    // away while still shooting (kiting). fleeSpeed is well under the
    // player's 55, so it is always catchable — running just costs you
    // time spent under fire, which is the point.
    fleeRadius:   46,
    fleeSpeed:    22,
    fleeProbe:    16,        // units ahead it checks for a clear retreat
  },

  // ═══ SHAHED — the intercept-mode target ═══
  // Flies straight and level at altitude, ignoring every obstacle. You
  // are faster but must weave, so the obstacles ARE the difficulty.
  shahed: {
    // Tuned against the real corridor by simulation: at 45 a clean
    // chase catches it about halfway down the run, while detours and
    // wobble can still cost you the mission. At 48 it was uncatchable.
    speed:       45,         // vs player 55
    altitude:    15,         // above all cover; only its shadow matters
    // Weave tuning is a speed-budget problem, not a taste one: matching
    // the lateral motion eats into the player's 55. At amp 30 / period 9
    // the peak lateral rate is ~21, leaving ~51 of forward capacity —
    // still above the Shahed's 45, so closing is always possible. Make
    // the weave much faster and there are moments the chase cannot be
    // won at all, which reads as unfair rather than hard.
    weaveAmp:    30,         // how far it drifts side to side
    weavePeriod: 9.0,        // sec per full weave cycle
    catchFactor: 0.8,        // blast radius fraction that counts as a kill
    bodyRadius:  4.0,        // ramming it (in plan view) also detonates you
  },
  cam: {
    height:   95,            // gameplay camera height
    backoff:  26,            // pulled back on +Z so the view tilts slightly
                             // (pure top-down hides 3D forms; a little tilt sells them)
    followLerp: 0.06,
    boomHeight: 48,          // zoomed height during detonation cinematic
    boomSlowmo: 0.28,        // time scale during the cinematic
    boomTime:   1.6,         // real seconds of cinematic
  },
  failRestartDelay: 2.4,     // sec before auto-restart after a miss

  // ═══ FX — everything each entity throws out, one block per emitter ═══
  // Each emitter block reads:
  //   count     particles per explosion
  //   speed     [min,max] launch speed — HOW FAR the spread reaches
  //   spreadDeg vertical cone above the ground, in degrees — HOW WIDE it
  //             lifts. Low (~15°) = flat sheet hugging the ground;
  //             high (~60°) = tall billow. Keep it well under 90°: with a
  //             top-down camera, straight up is straight at the lens.
  //   life      [min,max] seconds before the particle dies
  // The horizontal direction is always a full 360° — these control the
  // vertical shape and the reach of the spray.
  fx: {
    // ── DRONE (black) ──
    droneDebris: { count:300, speed:[14,54], spreadDeg:36, life:[1.0,2.4] }, // frame chunks
    droneSmoke:  { count:260, speed:[ 5,21], spreadDeg:52, life:[1.4,3.2] }, // lingering cloud
    droneFlash:  { count: 90, speed:[20,62], spreadDeg:36, life:[0.22,0.44]},// white core
    // ── ENEMY (red) ──
    enemyDebris: { count:120, speed:[5,10], spreadDeg:36, life:[0.7,1.5] },
    enemyEmbers: { count:120, speed:[5,20], spreadDeg:44, life:[0.5,1.4] }, // scatter further
    // ── SHAHED (red, airborne) — bigger and wider: it dies at altitude
    //    and rains down, so this one is allowed a taller cone ──
    shahedDebris:{ count:260, speed:[16,52], spreadDeg:48, life:[1.0,2.2] },
    shahedEmbers:{ count:160, speed:[24,70], spreadDeg:55, life:[0.6,1.6] },
    // ── SMALL STUFF ──
    ricochet:    { count:  8, speed:[ 6,20], spreadDeg:45, life:[0.3,0.3] },
    muzzle:      { count:  5, speed:[ 9,15], spreadDeg:12, life:[0.15,0.15]},

    // point size in world units — smaller reads as finer debris
    sizeBurst: 0.55,   // glowing cores: flash, embers, enemy debris
    sizeSmoke: 1.30,   // drone's black debris + smoke puffs
    sizeSpark: 0.40,   // ricochets, muzzle flash
    sizeTrail: 0.40,   // drone thrust

    // pool capacity. Emitting more than a pool holds recycles its oldest
    // particles, so raising a count is always safe; raise the pool too if
    // you want them all alive at once.
    poolBurst: 2600, poolSmoke: 1800, poolSpark: 600, poolTrail: 500,

    ringTime: 0.42,    // sec for the blast ring to reach full blast radius
  },
};

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
    joyZone:      70,        // px: how far the stick itself may drift from
                             // where it was first planted. The anchor
                             // follows the finger (so reversing is quick)
                             // but is penned inside this zone, so the stick
                             // cannot wander up the screen and imply speed
                             // that is not there.
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
    followLerp: 0.06,        // base follow rate, for normal flight
    // ...but firm up as the camera falls behind, so a hard turn does not
    // leave it trailing. Boost ramps in once the gap exceeds
    // followCatchFrom and maxes at (1 + followCatchBoost)x.
    followCatchFrom:  22,    // units of gap where catch-up starts
    followCatchBoost: 3.0,

    // ── Look-ahead ──
    // At speed the drone outruns the view and obstacles arrive with no
    // time to react, so the camera slides ahead along the direction of
    // travel. It eases in between leadFrom and leadFull of top speed,
    // over leadRampIn seconds, and drops back over leadRampOut.
    leadDistance: 30,        // units ahead at full lead
    leadSideways: false,     // lead on world X too? Off: the maps run
                             // north-south, so only the vertical axis is
                             // worth looking into, and sideways lead makes
                             // every strafe swing the view.
    leadFrom:     0.55,      // speed fraction where lead starts easing in
    leadFull:     0.90,      // speed fraction for full lead
    // These compound with followLerp, so the camera settles slower than
    // any one of them suggests: measured end-to-end, the lead reaches its
    // full offset about a second after you commit to full speed.
    leadRampIn:   0.3,       // sec to wind the lead up
    leadRampOut:  0.4,       // sec to wind it back down
    leadLerp:     0.01,      // base smoothing on the lead vector
    // Rapid direction changes need the lead to swing across fast — at a
    // 0.01 base rate a full reversal would take seconds. The boost scales
    // with (1-dot)/2 between the current and wanted lead directions:
    // 0 when unchanged, 1 when reversed. (Deliberately not the cross
    // product — sin(180°) is 0, so it would not react to a reversal.)
    leadTurnBoost: 14,       // rate multiplier at a full reversal

    boomHeight: 48,          // zoomed height during detonation cinematic
    // The detonation plays in three beats. First a near-freeze, long
    // enough to read the dead object hanging in the air as a cloud of its
    // own dots. Then slow motion while it comes apart. Then normal speed.
    freezeScale: 0.04,       // time scale during the freeze (near-stopped)
    freezeTime:  0.55,       // real seconds the freeze lasts
    boomSlowmo:  0.28,       // time scale after the freeze
    boomTime:    2.2,        // real seconds of cinematic overall
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
  // Destruction itself is handled by the SHATTER block further down —
  // these emitters are the accents layered on top of it.
  fx: {
    // ── DRONE (black) ──
    // `hold` delays these so they bloom only once the dot silhouette has
    // been seen — otherwise the flash washes the shape out immediately.
    droneSmoke:  { count:260, speed:[ 5,21], spreadDeg:52, life:[1.4,3.2], hold:0.46 },
    droneFlash:  { count: 90, speed:[20,62], spreadDeg:36, life:[0.22,0.44], hold:0.44 },
    // ── ENEMY / SHAHED (red) — embers on top of the shattered dots ──
    enemyEmbers: { count:120, speed:[5,20], spreadDeg:44, life:[0.5,1.4], hold:0.46 },
    shahedEmbers:{ count:160, speed:[24,70], spreadDeg:55, life:[0.6,1.6], hold:0.46 },
    // ── SMALL STUFF ──
    ricochet:    { count:  8, speed:[ 6,20], spreadDeg:45, life:[0.3,0.3] },
    muzzle:      { count:  5, speed:[ 9,15], spreadDeg:12, life:[0.15,0.15]},

    // ── SHATTER ──
    // On death an object is replaced by a cloud of dots sampled from its
    // own surfaces, which then fly apart and decay. The dots start in the
    // exact shape of the thing that died, so the silhouette is readable
    // for an instant before it comes apart — that is the whole effect.
    // `count` here is dots per object; they carry the object's own colours.
    // `hold` is [min,max] REAL seconds each dot sits motionless in the
    // object's shape before flying — the freeze-frame. Jittered per dot
    // so the cloud does not release as one rigid sheet.
    shatterDrone:  { count:420, speed:[ 9,38], spreadDeg:38, life:[0.9,2.0], hold:[0.42,0.60] },
    shatterEnemy:  { count:560, speed:[11,46], spreadDeg:38, life:[0.9,2.2], hold:[0.42,0.60] },
    shatterShahed: { count:520, speed:[13,52], spreadDeg:46, life:[0.9,2.0], hold:[0.42,0.60] },
    // Dot size in WORLD units, and the detonation camera sits ~48 units
    // up: on-screen pixels ≈ size * frameHeight / (2·tan(fov/2)·distance),
    // so 0.45 came out ~14 device px on a 2x phone screen — chunky
    // squares. 0.20 lands nearer 6 px, which reads as fine grain.
    // Raise it if the cloud looks too sparse on a big screen.
    sizeShard:  0.20,  // the shattered-object dots
    poolShard: 3000,

    // point size in world units — smaller reads as finer debris
    sizeBurst: 0.55,   // glowing cores: flash, embers
    sizeSmoke: 1.30,   // drone's smoke puffs
    sizeSpark: 0.40,   // ricochets, muzzle flash
    sizeTrail: 0.40,   // drone thrust

    // pool capacity. Emitting more than a pool holds recycles its oldest
    // particles, so raising a count is always safe; raise the pool too if
    // you want them all alive at once.
    poolBurst: 2600, poolSmoke: 1800, poolSpark: 600, poolTrail: 500,

    ringTime: 0.42,    // sec for the blast ring to reach full blast radius
  },
};

# ClaudeVfx — FPV // STRIKE

Browser game project. Everything runs as plain HTML + ES modules with no
build step, because development happens **entirely on an Android phone**
(Acode editor + Termux for git). That constraint drives every technical
choice here.

## Files

| File | Purpose |
|---|---|
| `index.html` | Shell only: markup, CSS, menu overlay, import map. No game logic. |
| `config.js` | `CFG` — every tunable number. How the game *feels*. |
| `levels.js` | Level definitions + world builders (`addBox`, `addHouse`, `addTree`, `addGrove`). The *shape* of each mission. |
| `game.js` | Engine: renderer, particles, entities, AI, input, HUD, states, main loop. |
| `fpv-3d-intercept.html` | Reference demo (not written by the project owner). Particle-morph animation. Kept as a technique reference — do not modify. |
| `fpv-3d-intercept_annotated.html` | Heavily commented study copy of that demo. |

Modules are loaded directly by the browser (`<script type="module" src="./game.js">`)
with Three.js r128 resolved through the import map in `index.html`. No npm,
no bundler, no compile step. Deploy = `git push` → GitHub Pages. Repo:
`lanzdev/ClaudeVfs`.

**Owner background:** Unity developer, new to JavaScript. Explanations
should lean on Unity analogies (Scene/Camera/Mesh/Material/`Update()`).
Comments explain *why*, and stay readable to someone who does not know JS
idioms.

**Phone target:** cap pixel ratio, keep particle counts modest, avoid
per-frame allocations, no post-processing (glow is faked with additive
sprite halos).

## The game

Top-down 3D. The FPV drone has no weapons — only its own detonation.

**Controls (both modes).** Relative virtual joystick: the first touch
anchors the stick where the finger lands and launches; offset from that
anchor sets direction and speed; the anchor is dragged along if the finger
passes the rim. **Releasing the finger detonates.** The only way to
disengage is to commit.

You also explode on: being shot, clipping an obstacle, ramming the target.
*Any* explosion resolves the mission, so dying close enough still wins.

### Mode `strike` (mission 1 — HUNTER)
Cross a village and destroy a patrolling gun position.
- The enemy **hears** you: inside its acoustic radius it tracks you
  through walls, but only **shoots** with clear line of sight. Cover keeps
  you alive, not hidden.
- It fires 30-round bursts, then reloads — the reload window (signalled by
  its core pulsing fast) is when you advance.
- **Flee AI**: inside `fleeRadius` it stops patrolling and backs away
  while still shooting (kiting). `fleeSpeed` is well under the player's,
  so it is always catchable — running just costs you time under fire. If
  boxed in, it stands and fights.
- Win: detonate with the enemy inside the blast radius.

### Mode `intercept` (mission 2 — INTERCEPT)
Chase a Shahed down a long corridor.
- It flies straight and level at altitude, **ignoring every obstacle**.
  You are faster but fly low, so the obstacles are the entire difficulty.
- It is drawn 15 units up while the camera looks straight down, so a
  **ground shadow blob** marks its true plan-view position. The shadow,
  not the aircraft, is what your blast has to reach.
- Win: detonate beneath it (`blastRadius * catchFactor`).
  Lose: it crosses the city line, or you die away from it.

## Mechanics worth knowing before editing

- **Two collider kinds, both flat.** Axis-aligned boxes (walls, blocks,
  house wall segments) and circles (tree trunks). Both block movement,
  bullets, and line of sight. The game is 2D underneath a 3D presentation.
- **Houses are enterable.** Each is four thick walls with gaps: a `door`
  gap (13 units, ~4 drones abreast) is flyable at speed; a `window` gap
  (2.2 units) is not — the drone is 2.8 wide — but bullets and enemy sight
  pass straight through. A house is cover you can hide *inside* that can
  still be shot into.
  **Houses must stay axis-aligned**: rotating one would require oriented-box
  tests in every collision and LoS call.
- **Level geometry is deterministic.** Groves are generated, not
  hand-placed, but they use a seeded xorshift RNG (`seedRandom` in
  `levels.js`, reseeded by `buildWorld` from each level's `seed`) so the
  same map comes out every time. `Math.random()` here would reshuffle the
  forest on every level load, making maps unlearnable and tests flaky.
- **Enemy movement always goes through `enemyStep`**, which refuses to
  enter geometry and slides along it. Never move `enemy.pos` directly:
  patrol originally did that, walked the enemy through walls, and left it
  embedded with nowhere legal to retreat to. `unstickEnemy()` is the
  recovery net, and a `stuckTimer` gives up on an unreachable waypoint.
- **Trees block sight**, so a grove is a concealment corridor. Acoustic
  detection ignores cover entirely — that is the intended tension.
- **Shahed weave tuning is a speed-budget problem.** Matching its lateral
  motion eats into the player's max speed. At `weaveAmp 30 / weavePeriod 9`
  the peak lateral rate is ~21, leaving ~51 of forward capacity against the
  Shahed's 45, so closing is always possible. A faster weave creates moments
  where the chase cannot be won at all, which reads as unfair, not hard.
- **The camera looks straight down**, so "up" is "at the player's face":
  keep explosion cones (`spreadDeg`) well under 90° or debris flies at the lens.
- **The Shahed's roll/yaw signs are counter-intuitive.** Its body sits at
  yaw π, and with Three's default XYZ Euler order the roll is applied in
  the body frame *before* that 180° yaw, which mirrors how it reads in
  world space. Banking into a turn toward +X needs a POSITIVE `rotation.z`
  and `π - offset` for yaw. Derive signs from the rotation matrices rather
  than guessing; getting them backwards makes it lean out of its turns.
- **Additive black is invisible**, so the drone's black smoke uses a
  separate normal-blended pool that fades toward the fog colour.
- **Two clocks in the main loop:** `rdt` is real time (camera, cinematics,
  UI); `sdt = rdt * timeScale` is simulation time (physics, AI, bullets).
  Slow motion shrinks `sdt` while `rdt` keeps flowing.
- **Particle pools are fixed-size ring buffers.** Emitting more than a pool
  holds recycles its oldest particles, so raising a count is always safe.
- Two canvases are stacked: WebGL for the 3D scene, a 2D canvas overlay for
  HUD markers (target state, off-screen direction chevron, joystick).

## Adding a level

Append a def to `LEVELS` in `levels.js` — the menu builds its buttons from
that array, so no other file changes:

```js
{ id, name, blurb, mode:'strike'|'intercept',
  world:{minX,maxX,minZ,maxZ}, playerStart,
  build(api){ /* api.worldGroup, api.boxes, api.trees */ },
  enemy:{ waypoints:[...] },              // strike
  shahed:{ start, escapeZ } }             // intercept
```

`buildWorld()` in `game.js` wipes the previous level's meshes (disposing
geometry; materials are shared constants in `levels.js` and are
deliberately not disposed) and rebuilds the collider arrays.

## Verifying changes

There is no way to see the game from the terminal, so verify mechanically.

1. **Syntax**: `node --check config.js && node --check levels.js && node --check game.js`
2. **Headless run**: stub Three.js and the DOM, import `game.js`, and step
   the main loop by draining a `requestAnimationFrame` queue. This catches
   what `--check` cannot — TDZ errors, bad property access, NaN, and
   crashes across level switches. Fire synthetic `pointerdown` /
   `pointermove` / `pointerup` on the canvas stub to play the game
   programmatically; read entity positions back out of the scene graph.
3. **Level validation**: run `build()` against a Three.js stub and assert
   on the collider arrays — spawn and waypoints clear, patrol legs
   unobstructed, doors wider than the drone, windows narrower, and a flood
   fill from spawn reaching ~100% of open cells (this is also what proves
   every house interior is enterable).
4. **Balance simulation**: for anything tuned by feel, simulate a pilot
   against the real level geometry rather than guessing. This is how the
   Shahed's speed was set — 48 made the chase mathematically unwinnable,
   45 gives a catch at roughly half the corridor.

Past bugs caught this way: a patrol path clipping an obstacle, debris
flying into the camera, and an uncatchable Shahed.

## Status and next steps

Two working missions, menu, full win/lose loops.

Open items:
- No sound, no score, no persistence of progress.
- Only one enemy per strike map; multiple enemies would need the entity
  turned into an array (currently a single object).
- Particles do not collide with obstacles (skipped: thousands of particles
  against ~100 colliders per frame is too costly on a phone).
- The intercept corridor is built from a repeating band pattern — fine for
  one mission, but it will read as repetitive if reused.

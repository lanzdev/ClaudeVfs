# Plan: splitting game.js into modules

**Status: not done, and deliberately deferred.** This is the plan to follow
*when* the trigger below fires — not something to do because the file feels
big. Written 2026-09-07, when `game.js` was ~1300 lines.

## Do this when (trigger)

Split when one of these actually happens, not before:

1. A **third game mode** is added, or
2. A **second enemy type** is added (turret + something else in one level), or
3. `game.js` passes roughly **2000 lines** and you find yourself scrolling
   past sections you never touch.

Until then the section banners in `game.js` are adequate navigation, and
fewer files is genuinely better on a phone editor.

## Why not split by game mode

This was the first instinct and it is the wrong axis. Measured before the
mode abstraction landed: only **324 of 1360 lines were mode-specific**
(enemy turret 223, Shahed 101). Everything else — particles 251, HUD 153,
world/collision 95, player, input, camera, explosions — is shared.
Splitting into `core.js` + `strike.js` + `intercept.js` would produce one
enormous core and two thin files, solving nothing.

Worse, **entities are not modes**. A future "defend the convoy" mode could
use the turret *and* a Shahed; an escort mode might use two turrets. If
enemy code lives inside `strike.js`, other modes must either import from a
sibling mode's file or duplicate it. Entities want their own files; modes
want to be thin things that *compose* entities.

## What already happened (the important half)

The abstraction was done on 2026-09-07 and is the reason this split is not
urgent. There is now a `MODES` registry in `game.js` (its own section) where
each mode answers a fixed set of questions:

```
target()        the thing to destroy (anything with .pos and .alive)
killRadius()    how close the blast must be, horizontally
markerHeight    height to project the HUD marker at
enter(def)      one-time setup on level load
reset(def)      per-attempt entity reset
update(dt, t)   advance this mode's entities
destroyTarget() kill + explode after a successful blast
marker()        {label, color, alpha} for the on-screen marker
markerExtras()  optional extra drawing (ammo bar, altitude line) — optional hook
status(inKill)  {text, color} for the third HUD status line
```

That removed **all 20 `mode === '...'` branches**; the engine now only ever
calls `M.<hook>()`. Adding a mode is already a matter of adding one registry
entry plus whatever entity it drives — no HUD, outcome, or loop changes.

**Keep it that way.** If a new mode tempts you to add `if (M.id === 'x')`
anywhere in shared code, that is the signal to add a hook instead.

## Target structure

Six files, not a dozen. On a phone, switching files costs more than
scrolling, so stop at the point where each file has one clear job.

| File | Contents | ~lines |
|---|---|---|
| `engine.js` | renderer, scene, camera, lights, ground, glow sprite helper, `lerp`/`clamp` | 90 |
| `particles.js` | `PHYS` presets, `sprayVelocity`, `emit`, `ParticlePool`, the four pools, `explodeDrone/Enemy/Shahed`, shockwave ring | 280 |
| `world.js` | `worldGroup`, collider arrays, `buildWorld`/`clearWorld`, circle/segment vs box+circle tests, `hasLineOfSight` | 100 |
| `entities.js` | player drone, enemy turret (+ AI), Shahed, bullets | 480 |
| `hud.js` | DOM status lines, `flash`, overlay canvas, `project`, `drawOverlay`, `updateHUD`, joystick input | 220 |
| `game.js` | `MODES` registry, game state machine, level loading, menu wiring, detonation/outcome, main loop | 230 |

Split `entities.js` into `entities/player.js`, `entities/enemy.js`,
`entities/shahed.js` only when one of them grows past ~250 lines.

## Dependency order (avoid import cycles)

Strictly one-directional. Nothing imports "upward":

```
config.js ─┐
levels.js ─┤
           ├→ engine.js → particles.js → world.js → entities.js → hud.js → game.js
```

`engine.js` must import nothing of ours (only `three` and `config.js`),
because everything needs `scene` and `camera` from it. If you ever feel the
need for an upward import, that code belongs in `game.js` instead — it is
the orchestrator and is allowed to know about everything.

## The trap: exported `let` is read-only for importers

This is the thing that will actually cost time. ES module exports are *live
bindings*: an importer sees the current value, but **assigning to an imported
binding throws a TypeError** (modules are always strict mode). It looks like
a shared static field but behaves like a getter.

`game.js` currently has ~16 module-level `let`s that would need to cross a
file boundary: `state`, `M`, `level`, `timeScale`, `failTimer`, `shake`,
`worldBounds`, `worldBorder`, `boomTimer`, `pendingWin`, `enemyBoomDelay`,
`activePointer`, `touching`, `flashCd`, `lastNow`.

Handle them one of three ways:

1. **Keep it private.** Most of these are only read/written inside one
   future module (`flashCd`, `activePointer`, `touching` → `hud.js`;
   `boomTimer`, `pendingWin` → `game.js`). These need no export at all —
   check before exporting anything.
2. **Shared mutable state → one exported object.** For the genuinely shared
   ones (`state`, `timeScale`, `M`, `level`), export a single frozen-shape
   object and mutate its fields: `export const G = { state: S.MENU,
   timeScale: 1, mode: null, level: null }`, then `G.state = S.FLYING`.
   Mutating a property of an imported object is fine; only rebinding the
   import itself is forbidden.
3. **Setter functions** (`setState()` already exists) where a state change
   needs side effects.

Prefer (1), then (2). Do not scatter setters for everything.

## Order of operations

Do it in small verified steps, running the harness after each:

1. `engine.js` first — it has the fewest dependencies. Export `scene`,
   `camera`, `renderer`, `canvas`, `makeGlow`, `glowTexture`, `lerp`, `clamp`.
2. `particles.js` — imports engine only.
3. `world.js` — imports engine + levels.
4. `entities.js` — imports engine, particles, world, config.
5. `hud.js` — imports engine, world (for `project`), plus the `G` state object.
6. Whatever remains is `game.js`.
7. Update `index.html`: it loads only `game.js`; the rest resolve through
   normal module imports. The import map stays as-is.

Step 1 alone is a good half-hour test of whether the approach feels right.

## Verification

The harness in the scratchpad (or rebuilt per `CLAUDE.md` → "Verifying
changes") must pass unchanged after every step. Its value here is exactly
this kind of refactor: it imports `game.js`, plays both modes with synthetic
touch events, and checks level rebuilds for leaks. A pure file split should
change **nothing** about its output.

Specifically re-run: `validate` (level geometry), `test-overlap`,
`test-house`, `harness` (runtime smoke), `test-hygiene` (rebuild leaks),
`test-strike` (detection/pursuit), `test-stuck` (enemy never embeds).

## What NOT to do

- Do not create a file per level. Levels are data; `levels.js` holds them
  fine until it passes ~600 lines, at which point split it by level, not by
  helper.
- Do not add a build step, bundler, or TypeScript. The whole project's value
  is that it deploys by `git push` and edits from a phone.
- Do not introduce a class hierarchy for entities. They are plain objects
  with an update function; that is appropriate at this size and keeps the
  code readable for someone coming from Unity's component model.

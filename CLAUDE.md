# ClaudeVfx — FPV // STRIKE

Browser game project. Everything runs as plain HTML + JavaScript with no
build step, because development happens **entirely on an Android phone**
(Acode editor + Termux for git). That constraint drives every technical
choice here.

## Files

| File | Purpose |
|---|---|
| `index.html` | **The game.** Single self-contained file. This is the live deliverable. |
| `fpv-3d-intercept.html` | Reference demo (not written by the project owner). A particle-morph animation of an FPV intercepting a Shahed. Kept as a technique reference — do not modify. |
| `fpv-3d-intercept_annotated.html` | Heavily commented study copy of the demo, with renamed variables. Explains the particle-morph technique. |

## Stack and constraints

- **Three.js r128**, loaded from cdnjs via an `<script type="importmap">`.
  No npm, no bundler, no compile step.
- One `.html` file containing HTML + CSS + an ES module `<script>`.
- Deploy = `git push` → GitHub Pages serves it. Repo: `lanzdev/ClaudeVfs`.
- Target device is a phone: cap pixel ratio, keep particle counts modest,
  avoid per-frame allocations, avoid post-processing (no real bloom —
  glow is faked with additive sprite halos).

**Owner background:** Unity developer, new to JavaScript. Explanations
should lean on Unity analogies (Scene/Camera/Mesh/Material/`Update()`).
Code comments should explain *why*, and stay readable to someone who does
not know JS idioms.

## The game

Top-down 3D kamikaze-approach game. Not a shooter — the FPV drone has no
weapons, only its own detonation.

**Core loop**
1. Fly from your spawn toward a patrolling enemy across a large map.
2. Use obstacles as cover to survive its bursts and close the distance.
3. Detonate with the enemy inside your blast radius.

**Rules**
- Touch and hold = fly. **Releasing your finger detonates** — the only way
  to disengage is to commit.
- You also explode on: being shot, clipping an obstacle, ramming the enemy.
- *Any* explosion resolves the level: enemy inside blast radius → win;
  outside → restart. Dying close enough still wins.
- The enemy **hears** you (acoustic detection radius) and tracks you
  through walls, but only **shoots** with clear line of sight. Cover keeps
  you alive, not hidden.
- It fires 30-round bursts, then reloads — the reload window is when you
  advance.

**Controls: relative virtual joystick.** First touch anchors the stick
where the finger lands; offset from that anchor sets direction and speed.
The anchor is dragged along if the finger passes the rim, so long swipes
never pin the stick. Deadzone near the anchor = hover.

## Visual direction

- Readable solid forms with smooth edges, built from Three.js primitives —
  no external 3D models (no desktop for Blender).
- **Enemy** = circle head + stick gun. Bullets leave the stick's far end.
- **Player drone** = square base + 4 circle motors, rotates to face its
  movement direction, glowing cyan pod marks the front.
- Objects are `THREE.Group`s of sub-meshes so each part carries its own
  material and color.
- **Glow is a gameplay language**, not decoration: glowing = vulnerable or
  important. The enemy's amber core pulses fast while reloading. The blast
  ring turns green and pulses when the kill is live.
- Particles are for explosions, debris, thrust and sparks — solid while
  alive, particle burst on death.
- Faction colors: drone explodes **black** (smoke), enemy explodes **red**.

## Code map (`index.html`)

The script is one module, sectioned by banner comments in this order:

```
CONFIG          all tunable numbers (see below)
RENDERER/SCENE  Three.js setup, lights, ground, world border
GLOW HELPERS    additive sprite halos (cheap fake bloom)
PARTICLES       physics presets, spray, pooled particle system, explosions
WORLD           obstacle boxes + collision / line-of-sight math
PLAYER          drone mesh, movement, blast ring
ENEMY           mesh, patrol AI, acoustic detection, shooting
BULLETS         projectile pool
EXPLOSIONS      detonation + win/lose resolution
CAMERA          follow cam, detonation dive, shake
INPUT           pointer events → virtual joystick
HUD             DOM status lines + 2D overlay canvas (markers, joystick)
GAME STATE      READY / FLYING / BOOM / WIN / FAIL + resetLevel()
MAIN LOOP       animate()
```

### Key conventions

- **`CFG` is the single tuning surface.** Gameplay feel, map bounds,
  camera, and all FX live there. Change a number, reload the page.
- **`CFG.fx` holds one block per particle emitter**, e.g.
  `droneDebris: { count, speed:[min,max], spreadDeg, life:[min,max] }`.
  `speed` = how far the spray reaches; `spreadDeg` = the vertical cone
  above the ground; horizontal direction is always 360°.
- **Two clocks in the main loop:** `rdt` is real time (camera, cinematics,
  UI), `sdt = rdt * timeScale` is simulation time (physics, AI, bullets).
  Slow motion shrinks `sdt` while `rdt` keeps flowing.
- **Particle pools are fixed-size ring buffers.** Emitting more than a
  pool holds recycles its oldest particles — raising a count is safe.
- **Additive black is invisible**, so the drone's black smoke uses a
  separate normal-blended pool that fades toward the fog color.
- **The camera looks straight down**, so "up" is "at the player's face":
  keep explosion cones well under 90° or debris flies at the lens.
- Two canvases are stacked: WebGL for the 3D scene, a 2D canvas overlay
  for HUD markers (enemy state, off-screen direction chevron, joystick).

## Verifying changes

There is no test suite and no way to see the game from the terminal.
After editing, at minimum syntax-check the module:

```bash
awk '/<script type="module">/{f=1;next}/<\/script>/{f=0}f' index.html > /tmp/game.mjs
node --check /tmp/game.mjs
```

For gameplay math (map layout, particle trajectories, spread), write a
throwaway `node -e` simulation rather than guessing — past bugs found this
way include a patrol path clipping an obstacle and debris flying into the
camera.

## Status and next steps

Working prototype: one enemy, one map, full win/lose loop.

Known open items:
- The approach can feel empty — the map is large with a single enemy.
  Content (more enemies, patrol routes that come to meet the player)
  rather than a smaller map.
- No sound, no menus, no score, no level progression.
- Particles do not collide with obstacles (skipped: ~36 boxes × thousands
  of particles per frame is too costly on a phone).

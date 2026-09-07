import * as THREE from 'three';

// ═══════════════════════════════════════════════════════════════════
// LEVELS — level definitions + the builders that turn them into
// geometry and collision data.
//
// A level def is:
//   { id, name, blurb, mode, world:{minX,maxX,minZ,maxZ}, playerStart,
//     build(api),                     // places the obstacles
//     enemy:{waypoints}               // 'strike' mode
//     shahed:{startZ,escapeZ,...}     // 'intercept' mode
//   }
//
// `build(api)` receives the three placement helpers below. Everything
// they emit goes into api.worldGroup (meshes), api.boxes (AABB
// colliders) and api.trees (circle colliders) — game.js owns those
// arrays and clears them between levels.
//
// COLLISION MODEL, and why houses are axis-aligned:
// obstacles are axis-aligned boxes (AABB) and circles. That keeps the
// per-frame collision and line-of-sight math trivial, which matters on
// a phone. Rotating a house would need oriented-box tests everywhere,
// so houses stay axis-aligned — vary their size and opening layout
// instead of their angle.
// ═══════════════════════════════════════════════════════════════════

// ── Deterministic randomness ──
// Groves and tree jitter are generated, not hand-placed, but they must
// come out IDENTICAL every time a level is built: a map the player can
// learn, and geometry that tests can reason about. Math.random() would
// reshuffle the forest on every level load, so levels use this seeded
// generator instead. buildWorld() reseeds before each build.
let _seed = 1;
export function seedRandom(s) { _seed = s >>> 0 || 1; }
function rnd() {
  // xorshift32 — tiny, fast, and good enough for scattering trees
  _seed ^= _seed << 13; _seed >>>= 0;
  _seed ^= _seed >> 17;
  _seed ^= _seed << 5;  _seed >>>= 0;
  return _seed / 4294967296;
}

// Materials shared by every level (created once, never disposed).
const MAT = {
  bunker: new THREE.MeshLambertMaterial({ color:0x1c2226 }),
  roof:   new THREE.MeshLambertMaterial({ color:0x2a3438 }),
  wall:   new THREE.MeshLambertMaterial({ color:0x3a3a34 }),  // house plaster
  lintel: new THREE.MeshLambertMaterial({ color:0x4a4a42 }),  // top edge of a wall
  trunk:  new THREE.MeshLambertMaterial({ color:0x2a1f16 }),
  leaf:   new THREE.MeshLambertMaterial({ color:0x18351c }),
  leaf2:  new THREE.MeshLambertMaterial({ color:0x142b18 }),
};

// Opening sizes. The drone is 2.8 units wide (radius 1.4).
export const OPENING = {
  door:   13.0,  // ~4 drones abreast: readable from altitude, and you can
                 // fly through at speed without lining anything up
  window:  4.2,  // THREADING THE NEEDLE: 0.7 units of clearance per side,
                 // through a wall 2.8 thick — so you must be lined up for
                 // the whole passage, not just at the mouth. A shortcut
                 // for a confident pilot, a wreck for a careless one.
                 // Also an asymmetry worth keeping: the enemy's body is
                 // 6 units across, so it can use doors but never windows.
};

// ── Solid block (the original "wall" obstacle) ──
function addBox(api, cx, cz, sx, sz, h, mat=MAT.bunker) {
  const box = new THREE.Mesh(new THREE.BoxGeometry(sx,h,sz), mat);
  box.position.set(cx, h/2, cz);
  api.worldGroup.add(box);
  // lighter slab on top: makes height readable from straight above
  const roof = new THREE.Mesh(new THREE.BoxGeometry(sx*0.9, 0.3, sz*0.9), MAT.roof);
  roof.position.set(cx, h+0.15, cz);
  api.worldGroup.add(roof);
  api.boxes.push({ minX:cx-sx/2, maxX:cx+sx/2, minZ:cz-sz/2, maxZ:cz+sz/2 });
}

// ── House ──
// Four walls around an open interior, each wall broken by openings.
// A door gap is flyable; a window slit is not — but bullets and the
// enemy's line of sight pass straight through it. So a house is cover
// you can hide *inside*, that can still be shot into.
//
// `openings` maps a side to a list of {at, type}:
//   side: 'n' (-Z), 's' (+Z), 'e' (+X), 'w' (-X)
//   at:   -1..1, position along that wall (0 = centered)
// Example: { s:[{at:0,type:'door'}], n:[{at:-0.4,type:'window'}] }
function addHouse(api, cx, cz, w, d, openings={}, h=8.5) {
  const T = 2.8;   // wall thickness — thick enough to read as masonry
                   // from altitude, and to make a window a real embrasure

  // Split one wall into the segments left over between its openings.
  // Returns [start,end] spans in wall-local coordinates (-len/2..len/2).
  function segments(len, list) {
    const gaps = (list||[])
      .map(o => {
        const size = OPENING[o.type] ?? OPENING.window;
        const c = (o.at ?? 0) * (len/2 - size/2);   // keep gaps inside the wall
        return [c - size/2, c + size/2];
      })
      .sort((a,b) => a[0]-b[0]);
    const segs = [];
    let cursor = -len/2;
    for (const [gs,ge] of gaps) {
      if (gs > cursor) segs.push([cursor, gs]);
      cursor = Math.max(cursor, ge);
    }
    if (cursor < len/2) segs.push([cursor, len/2]);
    return segs;
  }

  // one wall = a run of box segments along an axis
  function wall(side) {
    const horizontal = (side === 'n' || side === 's');
    const len = horizontal ? w : d;
    for (const [a,b] of segments(len, openings[side])) {
      const mid = (a+b)/2, span = b-a;
      if (span < 0.05) continue;
      let sx, sz, px, pz;
      if (horizontal) {
        sx = span; sz = T; px = cx+mid; pz = cz + (side==='n' ? -d/2 : d/2);
      } else {
        sx = T; sz = span; px = cx + (side==='w' ? -w/2 : w/2); pz = cz+mid;
      }
      const m = new THREE.Mesh(new THREE.BoxGeometry(sx,h,sz), MAT.wall);
      m.position.set(px, h/2, pz);
      api.worldGroup.add(m);
      // bright top edge so walls read as walls from directly above
      const cap = new THREE.Mesh(new THREE.BoxGeometry(sx, 0.25, sz), MAT.lintel);
      cap.position.set(px, h+0.12, pz);
      api.worldGroup.add(cap);
      api.boxes.push({ minX:px-sx/2, maxX:px+sx/2, minZ:pz-sz/2, maxZ:pz+sz/2 });
    }
  }
  wall('n'); wall('s'); wall('e'); wall('w');

  // faint interior floor — tells the player this is a space, not a block
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(w-T, d-T),
    new THREE.MeshBasicMaterial({ color:0x0d1418, transparent:true, opacity:0.55 })
  );
  floor.rotation.x = -Math.PI/2;
  floor.position.set(cx, 0.06, cz);
  api.worldGroup.add(floor);
}

// ── Tree ──
// A circular obstacle: trunk collision, and it blocks line of sight,
// so a dense grove is a concealment corridor. (The enemy still HEARS
// you inside its acoustic radius — cover is not invisibility.)
function addTree(api, x, z, r=1.15) {
  const h = 5 + rnd()*4;
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(r*0.55, r*0.75, h, 8), MAT.trunk);
  trunk.position.set(x, h/2, z);
  api.worldGroup.add(trunk);
  // two stacked cones = canopy, read clearly from above
  const c1 = new THREE.Mesh(new THREE.ConeGeometry(r*2.5, h*0.85, 9), MAT.leaf);
  c1.position.set(x, h*0.78, z);
  api.worldGroup.add(c1);
  const c2 = new THREE.Mesh(new THREE.ConeGeometry(r*1.8, h*0.7, 9), MAT.leaf2);
  c2.position.set(x, h*1.18, z);
  c2.rotation.y = rnd()*Math.PI;
  api.worldGroup.add(c2);
  api.trees.push({ x, z, r });
}

// ── Grove ──
// Rejection-samples `count` trees inside a radius, keeping them at
// least `minGap` apart so the drone can still thread through. Denser
// than the box rows, but never a solid wall.
function addGrove(api, cx, cz, radius, count, minGap=6.5) {
  const placed = [];
  let guard = count*40;
  while (placed.length < count && guard-- > 0) {
    const a = rnd()*Math.PI*2;
    const rr = Math.sqrt(rnd())*radius;    // sqrt = even area coverage
    const x = cx + Math.cos(a)*rr, z = cz + Math.sin(a)*rr;
    if (placed.some(p => Math.hypot(p.x-x, p.z-z) < minGap)) continue;
    placed.push({x,z});
    addTree(api, x, z, 0.95 + rnd()*0.45);
  }
}

export const BUILDERS = { addBox, addHouse, addTree, addGrove };

// ═══════════════════════════════════════════════════════════════════
// LEVEL 1 — STRIKE: a patrolling gun position in a village
// ═══════════════════════════════════════════════════════════════════
const level1 = {
  id: 'strike-1',
  seed: 20260907,        // fixes the generated tree layout — change to reshuffle
  name: 'HUNTER',
  blurb: 'Cross the village · destroy the gun position',
  mode: 'strike',
  world: { minX:-180, maxX:180, minZ:-315, maxZ:315 },
  playerStart: new THREE.Vector3(0, 0, 225),
  enemy: {
    waypoints: [
      new THREE.Vector3(-114, 0, -216),
      new THREE.Vector3( 102, 0, -234),
      new THREE.Vector3(  18, 0, -156),
    ],
  },
  build(api) {
    const { addBox, addHouse, addGrove } = BUILDERS;

    // ── Row 1 (spawn side): open, a couple of blocks to read as cover
    addBox(api, -60, 250, 20, 12, 7);
    addBox(api,  40, 255, 16, 14, 8);
    addBox(api, 120, 245, 18, 10, 6);

    // ── Row 2: first houses. Doors face the player (south) so the
    //    first ones you meet are obviously enterable.
    addHouse(api, -120, 205, 52, 42, {
      s: [{ at: 0,    type:'door'   }],
      n: [{ at:-0.35, type:'window' }, { at:0.45, type:'window' }],
      e: [{ at: 0,    type:'window' }],
    });
    addBox(api, -10, 195, 22, 10, 6);
    addHouse(api, 95, 205, 46, 44, {
      s: [{ at: 0.25, type:'door'   }],
      w: [{ at: 0,    type:'window' }],
      n: [{ at:-0.3,  type:'window' }],
    });

    // ── Row 3: first grove — teaches that trees hide you
    addGrove(api, -70, 155, 34, 16);
    addBox(api, 30, 145, 14, 14, 10);
    addBox(api, 150, 150, 16, 10, 6);

    // ── Row 4
    addBox(api, -150, 105, 16, 12, 7);
    addHouse(api, -35, 95, 58, 36, {
      s: [{ at:-0.5, type:'door'   }, { at:0.55, type:'window' }],
      n: [{ at: 0,   type:'door'   }],                 // through-route
      e: [{ at: 0,   type:'window' }],
      w: [{ at: 0,   type:'window' }],
    });
    addBox(api, 70, 105, 10, 16, 8);
    addBox(api, 140, 90, 14, 12, 9);

    // ── Row 5
    addGrove(api, 120, 45, 36, 18);
    addBox(api, -100, 55, 12, 18, 8);
    addBox(api, 0, 45, 24, 10, 6);

    // ── Row 6: mid-map hamlet, the halfway landmark
    addBox(api, -160, 5, 14, 10, 7);
    addHouse(api, -55, -5, 48, 46, {
      n: [{ at: 0,   type:'door'   }],
      s: [{ at: 0.3, type:'window' }],
      e: [{ at:-0.4, type:'window' }, { at:0.4, type:'window' }],
    });
    addHouse(api, 50, 0, 42, 34, {
      w: [{ at: 0,   type:'door'   }],
      n: [{ at: 0,   type:'window' }],
    });
    addBox(api, 130, -10, 12, 14, 8);

    // ── Row 7
    addBox(api, -110, -55, 16, 12, 7);
    addGrove(api, -5, -50, 30, 14);
    addBox(api, 80, -60, 20, 10, 6);
    addBox(api, 160, -50, 10, 12, 7);

    // ── Row 8
    addBox(api, -60, -105, 18, 8, 6);
    addBox(api, 20, -110, 10, 14, 8);
    addHouse(api, 112, -100, 46, 38, {
      s: [{ at:-0.3, type:'door'   }],
      w: [{ at: 0,   type:'window' }],
    });

    // ── Row 9: approach to the patrol area — dense, for the final push
    addBox(api, -130, -155, 14, 12, 8);
    addBox(api, -30, -140, 20, 10, 6);
    addGrove(api, 68, -152, 30, 15);
    addBox(api, 150, -160, 14, 10, 7);

    // ── Row 10-11: inside the patrol zone
    addBox(api, -95, -190, 16, 10, 7);
    addBox(api, 10, -210, 12, 12, 10);
    addBox(api, 100, -200, 18, 8, 6);
    addBox(api, -40, -255, 14, 12, 7);
    addBox(api, 60, -260, 16, 10, 8);
  },
};

// ═══════════════════════════════════════════════════════════════════
// LEVEL 2 — INTERCEPT: chase a Shahed down a corridor
// The Shahed flies straight, fast, and at altitude (it ignores every
// obstacle). You are faster but must weave — the obstacles are the
// entire difficulty. Let it reach the city and the run is lost.
// ═══════════════════════════════════════════════════════════════════
const level2 = {
  id: 'intercept-1',
  seed: 71104,           // fixes the generated tree layout — change to reshuffle
  name: 'INTERCEPT',
  blurb: 'Chase the Shahed · detonate beneath it before the city',
  mode: 'intercept',
  world: { minX:-90, maxX:90, minZ:-1400, maxZ:220 },
  playerStart: new THREE.Vector3(0, 0, 150),
  shahed: {
    // 110 units ahead of the player. A clean pursuit catches it around
    // 17s into its 29s run — the remaining slack is what obstacle
    // detours eat, so sloppy flying loses the mission.
    start:   new THREE.Vector3(0, 0, 40),
    escapeZ: -1330,                         // cross this and the city is hit
  },
  build(api) {
    const { addBox, addHouse, addGrove } = BUILDERS;

    // Corridor content, generated in bands so density is even but the
    // layout still varies. Deterministic-ish: sizes vary, but every
    // band leaves at least one threadable lane (validated offline).
    const bands = [
      { z:   20, kind:'box'   },
      { z:  -40, kind:'grove' },
      { z: -110, kind:'house' },
      { z: -180, kind:'box'   },
      { z: -250, kind:'grove' },
      { z: -320, kind:'box'   },
      { z: -390, kind:'house' },
      { z: -460, kind:'grove' },
      { z: -530, kind:'box'   },
      { z: -600, kind:'grove' },
      { z: -670, kind:'house' },
      { z: -740, kind:'box'   },
      { z: -810, kind:'grove' },
      { z: -880, kind:'box'   },
      { z: -950, kind:'house' },
      { z:-1020, kind:'grove' },
      { z:-1090, kind:'box'   },
      { z:-1160, kind:'grove' },
      { z:-1230, kind:'box'   },
    ];

    bands.forEach((b, i) => {
      // alternate which side is crowded, so the open lane snakes
      const side = (i % 2 === 0) ? -1 : 1;
      if (b.kind === 'box') {
        addBox(api, side*48, b.z,      26, 14, 8);
        addBox(api, -side*20, b.z-24,  20, 12, 7);
      } else if (b.kind === 'grove') {
        addGrove(api, side*42, b.z, 26, 11);
        addGrove(api, -side*30, b.z-30, 18, 6);
      } else {
        addHouse(api, side*40, b.z, 46, 36, {
          s: [{ at:0, type:'door' }],
          n: [{ at:0, type:'door' }],          // fly-through shortcut
          e: [{ at:0, type:'window' }],
        });
        addBox(api, -side*40, b.z-26, 18, 12, 7);
      }
    });

    // ── The city: a glowing strip at the far end. Reaching it = fail.
    const strip = new THREE.Mesh(
      new THREE.PlaneGeometry(180, 40),
      new THREE.MeshBasicMaterial({ color:0xff3344, transparent:true, opacity:0.16,
        blending:THREE.AdditiveBlending, depthWrite:false })
    );
    strip.rotation.x = -Math.PI/2;
    strip.position.set(0, 0.1, -1330);
    api.worldGroup.add(strip);
    // skyline silhouette behind it, so the stakes are visible
    for (let i=0;i<14;i++) {
      const w = 8+rnd()*14, h = 14+rnd()*30;
      const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, 10),
        new THREE.MeshLambertMaterial({ color:0x141a20 }));
      b.position.set(-85 + i*13 + rnd()*4, h/2, -1360-rnd()*20);
      api.worldGroup.add(b);
    }
  },
};

export const LEVELS = [level1, level2];

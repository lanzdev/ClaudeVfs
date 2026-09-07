import * as THREE from 'three';
import { CFG } from './config.js';
import { LEVELS, seedRandom } from './levels.js';

// ═══════════════════════════════════════════════════
// RENDERER / SCENE
// ═══════════════════════════════════════════════════
const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias:true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x000308, 0.0028);
const camera = new THREE.PerspectiveCamera(55, innerWidth/innerHeight, 0.1, 1000);

// Lights — meshes need light (particles in the demo didn't)
scene.add(new THREE.HemisphereLight(0x223344, 0x080a08, 0.9));
const sun = new THREE.DirectionalLight(0x8899aa, 0.8);
sun.position.set(30, 80, 20);
scene.add(sun);

// Ground: dark plane + faint grid so motion is readable.
// Permanent — only level geometry is rebuilt between missions.
{
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(3200, 3200),
    new THREE.MeshLambertMaterial({ color:0x0a0f0a })
  );
  ground.rotation.x = -Math.PI/2;
  scene.add(ground);
  const grid = new THREE.GridHelper(3200, 640, 0x113322, 0x0d1a12);
  grid.material.transparent = true;
  grid.material.opacity = 0.35;
  grid.position.y = 0.02;
  scene.add(grid);
}

// ═══════════════════════════════════════════════════
// GLOW HELPERS — a soft radial-gradient sprite = cheap halo.
// This is the "glow language": glowing part = vulnerable/important.
// ═══════════════════════════════════════════════════
const glowTexture = (() => {
  const cv = document.createElement('canvas'); cv.width = cv.height = 64;
  const cx = cv.getContext('2d');
  const grad = cx.createRadialGradient(32,32,0, 32,32,32);
  grad.addColorStop(0,   'rgba(255,255,255,1)');
  grad.addColorStop(0.35,'rgba(255,255,255,0.35)');
  grad.addColorStop(1,   'rgba(255,255,255,0)');
  cx.fillStyle = grad; cx.fillRect(0,0,64,64);
  return new THREE.CanvasTexture(cv);
})();

// A crisp round dot, in contrast to the soft glow above: a hard-edged
// filled circle, antialiased only by the canvas rasteriser. Plain square
// points read as chunky pixels once they cover more than a few device
// pixels, which is what the shattered-object dots do at the detonation
// camera height.
const dotTexture = (() => {
  const cv = document.createElement('canvas'); cv.width = cv.height = 32;
  const cx = cv.getContext('2d');
  cx.fillStyle = '#fff';
  cx.beginPath(); cx.arc(16, 16, 13, 0, Math.PI*2); cx.fill();
  return new THREE.CanvasTexture(cv);
})();

function makeGlow(color, size) {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({
    map:glowTexture, color, transparent:true,
    blending:THREE.AdditiveBlending, depthWrite:false
  }));
  s.scale.set(size, size, 1);
  return s;
}

const lerp  = (a,b,t) => a+(b-a)*t;
const clamp = (v,lo,hi) => Math.max(lo, Math.min(hi, v));

// ═══════════════════════════════════════════════════
// PARTICLES — one pooled system, reused for explosions,
// sparks, and the drone's thrust trail. Same technique as
// the demo: Float32 arrays + additive Points, faded by
// darkening color (additive black = invisible).
// ═══════════════════════════════════════════════════
const FLOOR_Y = 0.15;   // ground level for particle collision

// Physics presets. Debris behaves like broken airframe: heavy, bounces
// once or twice, skids, stops. Smoke floats and stalls. Sparks are light
// and lively. Thrust just falls away behind the drone.
const PHYS = {
  DEBRIS: { grav: 62, bounce: 0.34, drag: 0.55 },
  SMOKE:  { grav:-1.2, bounce: 0,    drag: 2.10 },  // negative gravity = buoyant
  SPARK:  { grav: 48, bounce: 0.45, drag: 1.20 },
  THRUST: { grav: 10, bounce: 0,    drag: 2.60 },
};

// Explosion spray direction: 360° horizontally, biased LOW vertically.
// With a top-down camera, straight up means straight at the lens, so
// debris that flies up reads as flying into the player's face. Squaring
// the random keeps most pieces shallow, with only a few reaching the top
// of the cone (spreadDeg).
const DEG = Math.PI/180;
function sprayVelocity(speed, elevMaxRad, out) {
  const ang  = Math.random()*Math.PI*2;
  const elev = Math.pow(Math.random(), 2) * elevMaxRad;
  const horiz = Math.cos(elev)*speed;
  out.x = Math.cos(ang)*horiz;
  out.y = Math.sin(elev)*speed*0.55;                // damped vertical component
  out.z = Math.sin(ang)*horiz;
  return out;
}
const _spray = { x:0, y:0, z:0 };   // scratch, avoids per-particle allocation
const _col   = { r:0, g:0, b:0 };

// Emit one burst from a CFG.fx emitter block. `colorFn(out, rnd)` fills
// _col per particle, so each emitter keeps its own palette.
// `spec.hold` (optional) delays the whole burst by that many real
// seconds — used to let the shattered silhouette read before the fire
// and smoke bloom over it.
function emit(pool, spec, x,y,z, phys, power, colorFn, spawnJitter=0) {
  const n = Math.floor(spec.count*power);
  const elevMax = spec.spreadDeg*DEG;
  const hold = spec.hold ?? 0;
  for (let i=0;i<n;i++) {
    const speed = lerp(spec.speed[0], spec.speed[1], Math.random())*power;
    const v = sprayVelocity(speed, elevMax, _spray);
    const life = lerp(spec.life[0], spec.life[1], Math.random());
    colorFn(_col, Math.random());
    pool.spawn(
      x + (Math.random()-.5)*spawnJitter,
      y + Math.random()*spawnJitter,
      z + (Math.random()-.5)*spawnJitter,
      v.x, v.y, v.z, life, _col.r, _col.g, _col.b, phys, hold);
  }
}

class ParticlePool {
  // opts.blending: AdditiveBlending (default, glowing) or NormalBlending
  // (opaque — needed for BLACK particles, since additive black = invisible).
  // opts.map: soft round texture instead of square points.
  constructor(count, pointSize, opts={}) {
    this.count = count;
    this.pos  = new Float32Array(count*3);
    this.vel  = new Float32Array(count*3);
    this.base = new Float32Array(count*3);   // base color
    this.life = new Float32Array(count);     // remaining
    this.max  = new Float32Array(count);     // initial life
    this.grav = new Float32Array(count);     // downward accel
    this.bnc  = new Float32Array(count);     // ground restitution (0 = no bounce)
    this.drg  = new Float32Array(count);     // air drag coefficient
    this.dly  = new Float32Array(count);     // hold time before it moves
    this.head = 0;
    for (let i=0;i<count;i++) this.pos[i*3+1] = -999; // park below ground
    const g = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.pos, 3);
    g.setAttribute('position', this.posAttr);
    const colors = new Float32Array(count*3);
    this.colAttr = new THREE.BufferAttribute(colors, 3);
    g.setAttribute('color', this.colAttr);
    this.opaque = opts.blending === THREE.NormalBlending;
    // Opaque (smoke) pools need a real alpha channel to fade; additive
    // pools fade by darkening their color instead.
    this.alphaAttr = null;
    const mat = new THREE.PointsMaterial({
      size:pointSize, vertexColors:true, transparent:true,
      blending:opts.blending || THREE.AdditiveBlending,
      depthWrite:false, sizeAttenuation:true,
      map:opts.map || null, opacity:this.opaque ? 0.85 : 1
    });
    this.mesh = new THREE.Points(g, mat);
    this.mesh.frustumCulled = false;   // particles move far from origin
    scene.add(this.mesh);
  }
  // Overwrites the oldest slot — pool never grows.
  // `phys` is one of the shared PHYS presets below (passed by reference,
  // so spawning hundreds of particles allocates nothing).
  // `delay` (REAL seconds) holds the particle motionless at full
  // brightness before its physics starts — this is what lets a shattered
  // object be seen as a dot cloud in its own shape before it flies apart.
  spawn(x,y,z, vx,vy,vz, life, r,g,b, phys=PHYS.DEBRIS, delay=0) {
    const i = this.head; this.head = (this.head+1)%this.count;
    this.pos[i*3]=x;   this.pos[i*3+1]=y;   this.pos[i*3+2]=z;
    this.vel[i*3]=vx;  this.vel[i*3+1]=vy;  this.vel[i*3+2]=vz;
    this.base[i*3]=r;  this.base[i*3+1]=g;  this.base[i*3+2]=b;
    this.life[i]=life; this.max[i]=life;
    this.grav[i]=phys.grav; this.bnc[i]=phys.bounce; this.drg[i]=phys.drag;
    this.dly[i]=delay;
  }
  // dt  = simulation time (scaled by slow motion) — physics and lifetime
  // rdt = real time — the hold, so a freeze-frame lasts a predictable
  //       number of wall-clock seconds no matter how deep the slow-mo is
  update(dt, rdt = dt) {
    const c = this.colAttr.array;
    // Opaque particles can't fade by darkening (black is already black),
    // so they fade toward the background/fog color instead — which reads
    // as smoke dissolving into the night.
    const FOG_R = 0.000, FOG_G = 0.012, FOG_B = 0.031;
    for (let i=0;i<this.count;i++) {
      if (this.life[i] <= 0) {
        if (this.opaque) this.pos[i*3+1] = -999;   // park it out of sight
        c[i*3]=c[i*3+1]=c[i*3+2]=0;
        continue;
      }
      // held: sit still at full brightness, not ageing yet
      if (this.dly[i] > 0) {
        this.dly[i] -= rdt;
        c[i*3]=this.base[i*3]; c[i*3+1]=this.base[i*3+1]; c[i*3+2]=this.base[i*3+2];
        continue;
      }

      this.life[i] -= dt;

      // gravity + air drag (drag as a stable exponential-ish damping)
      this.vel[i*3+1] -= this.grav[i]*dt;
      const damp = 1/(1 + this.drg[i]*dt);
      this.vel[i*3]   *= damp;
      this.vel[i*3+1] *= damp;
      this.vel[i*3+2] *= damp;

      this.pos[i*3]   += this.vel[i*3]*dt;
      this.pos[i*3+1] += this.vel[i*3+1]*dt;
      this.pos[i*3+2] += this.vel[i*3+2]*dt;

      // ground contact: bounce if it still has downward speed, else
      // settle and let friction bring it to rest (debris comes to a stop
      // on the ground instead of sliding away forever)
      if (this.pos[i*3+1] < FLOOR_Y) {
        this.pos[i*3+1] = FLOOR_Y;
        const vy = this.vel[i*3+1];
        if (this.bnc[i] > 0 && vy < -2.5) {
          this.vel[i*3+1] = -vy*this.bnc[i];
          const fr = 0.72;                 // tangential loss on impact
          this.vel[i*3] *= fr; this.vel[i*3+2] *= fr;
        } else {
          this.vel[i*3+1] = 0;
          const fr = 1/(1 + 6*dt);         // rolling/sliding friction
          this.vel[i*3] *= fr; this.vel[i*3+2] *= fr;
        }
      }
      const a = Math.max(this.life[i]/this.max[i], 0);
      if (this.opaque) {
        c[i*3]  =lerp(FOG_R, this.base[i*3],   a);
        c[i*3+1]=lerp(FOG_G, this.base[i*3+1], a);
        c[i*3+2]=lerp(FOG_B, this.base[i*3+2], a);
      } else {
        c[i*3]=this.base[i*3]*a; c[i*3+1]=this.base[i*3+1]*a; c[i*3+2]=this.base[i*3+2]*a;
      }
    }
    this.posAttr.needsUpdate = true;
    this.colAttr.needsUpdate = true;
  }
  clear() { this.life.fill(0); for(let i=0;i<this.count;i++) this.pos[i*3+1]=-999; }
}

const burstPool = new ParticlePool(CFG.fx.poolBurst, CFG.fx.sizeBurst); // glowing cores
const sparkPool = new ParticlePool(CFG.fx.poolSpark, CFG.fx.sizeSpark); // impacts, muzzle
const trailPool = new ParticlePool(CFG.fx.poolTrail, CFG.fx.sizeTrail); // drone thrust
// Smoke pool: opaque + soft round sprites, so BLACK actually shows up
// (additive black draws nothing). Used for the drone's own detonation.
const smokePool = new ParticlePool(CFG.fx.poolSmoke, CFG.fx.sizeSmoke, {
  blending: THREE.NormalBlending, map: glowTexture
});

// Shard pool: the shattered-object dots. Normal blending so an object's
// own colours read correctly (the drone is nearly black, and additive
// black draws nothing), and no sprite map so they stay crisp points.
const shardPool = new ParticlePool(CFG.fx.poolShard, CFG.fx.sizeShard, {
  blending: THREE.NormalBlending, map: dotTexture
});

// ═══════════════════════════════════════════════════
// SHATTER — turn a solid object into a cloud of dots
//
// Instead of hand-authoring a second, dot-shaped copy of every model
// (the approach the reference demo used), the dots are SAMPLED from the
// object's own triangles: pick a triangle with probability proportional
// to its area, then a random point inside it. The cloud therefore always
// matches whatever the object actually looks like, and editing a model
// needs no matching edit here.
//
// Sampling is done ONCE at startup and cached in the object's local
// space; at detonation the points are just transformed by the object's
// current world matrix. Doing the triangle walk mid-explosion would
// drop frames on a phone.
// ═══════════════════════════════════════════════════
function buildPointCloud(root, count) {
  root.updateMatrixWorld(true);
  const parts = [];        // the source meshes, in traversal order
  const tris = [];
  let totalArea = 0;

  root.traverse(o => {
    const pos = o.isMesh && o.geometry && o.geometry.attributes
              ? o.geometry.attributes.position : null;
    if (!pos) return;                       // sprites, glows, empty stubs
    const idx = o.geometry.index;
    const part = parts.push(o) - 1;
    const c = o.material && o.material.color ? o.material.color : null;
    const col = c ? [c.r, c.g, c.b] : [0.5,0.5,0.5];
    const triCount = idx ? Math.floor(idx.count/3) : Math.floor(pos.count/3);
    const a = new THREE.Vector3(), b = new THREE.Vector3(), d = new THREE.Vector3();
    const ab = new THREE.Vector3(), ac = new THREE.Vector3();
    for (let t=0; t<triCount; t++) {
      const i0 = idx ? idx.getX(t*3)   : t*3;
      const i1 = idx ? idx.getX(t*3+1) : t*3+1;
      const i2 = idx ? idx.getX(t*3+2) : t*3+2;
      // kept in the SOURCE MESH's own space — see the note above about
      // sub-objects that rotate independently of the root
      a.fromBufferAttribute(pos, i0);
      b.fromBufferAttribute(pos, i1);
      d.fromBufferAttribute(pos, i2);
      // area weighting assumes no scale on the mesh, which holds for
      // everything here (all entities are unscaled primitives)
      const area = ab.subVectors(b,a).cross(ac.subVectors(d,a)).length()*0.5;
      if (!(area > 0)) continue;
      totalArea += area;
      tris.push({ ax:a.x, ay:a.y, az:a.z, bx:b.x, by:b.y, bz:b.z,
                  cx:d.x, cy:d.y, cz:d.z, cum:totalArea, col, part });
    }
  });

  const pts  = new Float32Array(count*3);
  const cols = new Float32Array(count*3);
  const src  = new Uint16Array(count);      // which mesh each dot came from
  if (!tris.length) return { pts, cols, src, parts, count:0 };

  for (let i=0; i<count; i++) {
    // area-weighted pick, then a uniform point inside that triangle
    const target = Math.random()*totalArea;
    let lo = 0, hi = tris.length-1;
    while (lo < hi) { const mid = (lo+hi)>>1; if (tris[mid].cum < target) lo = mid+1; else hi = mid; }
    const T = tris[lo];
    let u = Math.random(), v = Math.random();
    if (u+v > 1) { u = 1-u; v = 1-v; }      // fold into the triangle
    const w = 1-u-v;
    pts[i*3]   = T.ax*w + T.bx*u + T.cx*v;
    pts[i*3+1] = T.ay*w + T.by*u + T.cy*v;
    pts[i*3+2] = T.az*w + T.bz*u + T.cz*v;
    cols[i*3] = T.col[0]; cols[i*3+1] = T.col[1]; cols[i*3+2] = T.col[2];
    src[i] = T.part;
  }
  return { pts, cols, src, parts, count };
}

// Emit a cached cloud as flying dots. Velocities are radial from the
// object's centre, so each dot leaves along the direction it sat in —
// the shape visibly comes apart rather than scattering at random.
const _v3 = new THREE.Vector3();
function shatter(cloud, root, spec, phys=PHYS.DEBRIS, tint=null) {
  if (!cloud || !cloud.count) return;
  // Refresh every part's world matrix, then place each dot with the
  // matrix of the mesh it was sampled from. This is what keeps the cloud
  // aligned with sub-objects that move independently of the root — the
  // enemy's turret being the case that caught it.
  root.updateMatrixWorld(true);
  const n = Math.min(spec.count, cloud.count);
  const elevMax = spec.spreadDeg*DEG;
  const ox = root.position.x, oy = root.position.y, oz = root.position.z;
  for (let i=0; i<n; i++) {
    const part = cloud.parts[cloud.src[i]];
    _v3.set(cloud.pts[i*3], cloud.pts[i*3+1], cloud.pts[i*3+2])
       .applyMatrix4(part.matrixWorld);
    // outward from the object's centre, flattened toward the ground so
    // debris does not fly at the top-down camera (see sprayVelocity)
    let dx = _v3.x-ox, dy = _v3.y-oy, dz = _v3.z-oz;
    const len = Math.hypot(dx, dy, dz) || 1;
    const speed = lerp(spec.speed[0], spec.speed[1], Math.random());
    const flat = Math.hypot(dx, dz) || 1;
    const elev = Math.min(Math.abs(Math.atan2(dy, flat)), elevMax) * Math.sign(dy||1);
    const horiz = Math.cos(elev)*speed;
    const vx = (dx/flat)*horiz + (Math.random()-.5)*4;
    const vy = Math.sin(elev)*speed*0.55 + Math.random()*3;
    const vz = (dz/flat)*horiz + (Math.random()-.5)*4;
    const life = lerp(spec.life[0], spec.life[1], Math.random());
    const r = tint ? lerp(cloud.cols[i*3],   tint[0], tint[3]) : cloud.cols[i*3];
    const g = tint ? lerp(cloud.cols[i*3+1], tint[1], tint[3]) : cloud.cols[i*3+1];
    const b = tint ? lerp(cloud.cols[i*3+2], tint[2], tint[3]) : cloud.cols[i*3+2];
    // The hold is what makes this read as "the object turned into dots"
    // rather than "an explosion happened": every dot sits exactly where
    // its piece of the model was. A little per-dot jitter on the release
    // stops the cloud from breaking apart as one rigid sheet.
    const hold = spec.hold ? lerp(spec.hold[0], spec.hold[1], Math.random()) : 0;
    shardPool.spawn(_v3.x, _v3.y, _v3.z, vx, vy, vz, life, r, g, b, phys, hold);
  }
}

// Filled in once the entity meshes exist (see SHATTER CLOUDS below).
let droneCloud = null, enemyCloud = null, shahedCloud = null;

// ── DRONE DETONATION: black smoke ──
// A dense charcoal cloud with a brief white-hot flash at the center,
// so the blast still reads as an explosion and not just a dark puff.
function explodeDrone(x,y,z, power=1) {
  const F = CFG.fx;
  // the drone itself comes apart into dots of its own airframe
  shatter(droneCloud, player.group, F.shatterDrone, PHYS.DEBRIS);
  // lingering smoke cloud: slow, buoyant, stalls in place
  emit(smokePool, F.droneSmoke, x,y,z, PHYS.SMOKE, power, (c,r) => {
    const shade = 0.08+r*0.16; c.r=shade; c.g=shade; c.b=shade*1.10;
  }, 1.5);
  // brief white-hot flash core so the blast still reads as an explosion
  emit(burstPool, F.droneFlash, x,y,z, PHYS.SPARK, power, c => {
    c.r=0.9; c.g=0.92; c.b=1.0;
  });
  spawnShockwave(x, z, power);
}

// ── ENEMY DESTRUCTION: red burst ──
// Glowing crimson, no shockwave ring (that ring is the drone's blast
// signature — the enemy just dies).
function explodeEnemy(x,y,z, power=1) {
  const F = CFG.fx;
  // the turret comes apart into dots of itself, pushed halfway toward
  // red so the faction colour still reads at a glance
  shatter(enemyCloud, enemy.group, F.shatterEnemy, PHYS.DEBRIS, [1.0, 0.12, 0.05, 0.5]);
  // hot embers on top, to keep the blast reading as fire
  emit(burstPool, F.enemyEmbers, x,y,z, PHYS.SPARK, power, (c,r) => {
    c.r=1.0; c.g=0.35+r*0.3; c.b=0.08;
  });
}

// ── SHAHED DESTRUCTION: red burst at altitude ──
// Same palette as the enemy, but bigger and thrown wider — it dies in
// the air, so the debris gets a taller cone and rains down.
function explodeShahed(x,y,z, power=1) {
  const F = CFG.fx;
  // the airframe comes apart at altitude and rains down
  shatter(shahedCloud, shahed.group, F.shatterShahed, PHYS.DEBRIS, [1.0, 0.14, 0.05, 0.5]);
  emit(burstPool, F.shahedEmbers, x,y,z, PHYS.SPARK, power, (c,r) => {
    c.r=1.0; c.g=0.38+r*0.3; c.b=0.08;
  });
}

// ── Blast ring ──
// Drawn as a LINE circle, not a ring mesh: scaling a mesh scales its
// thickness too (the border fattened as it grew), while a line stays a
// hairline at any radius. It expands from zero to EXACTLY the drone's
// blast radius and then disappears — so it reads as a precise statement
// of what the detonation covered, not a decorative wave.
const unitCircleGeo = (() => {
  const pts = [];
  for (let i=0;i<72;i++) {
    const a = i/72*Math.PI*2;
    pts.push(new THREE.Vector3(Math.cos(a), 0, Math.sin(a)));
  }
  return new THREE.BufferGeometry().setFromPoints(pts);
})();

const shockwaves = [];
function spawnShockwave(x, z, power) {
  const ring = new THREE.LineLoop(unitCircleGeo,
    new THREE.LineBasicMaterial({ color:0xffaa55, transparent:true, opacity:0.95,
      blending:THREE.AdditiveBlending, depthWrite:false }));
  ring.position.set(x, 0.3, z);
  ring.scale.setScalar(0.001);
  scene.add(ring);
  shockwaves.push({ ring, t:0, radius: CFG.player.blastRadius*power });
}
function updateShockwaves(dt) {
  for (let i=shockwaves.length-1;i>=0;i--) {
    const s = shockwaves[i]; s.t += dt;
    const k = Math.min(s.t/CFG.fx.ringTime, 1);
    const eased = 1-(1-k)*(1-k);          // fast out, easing into the final radius
    s.ring.scale.setScalar(Math.max(s.radius*eased, 0.001));
    s.ring.material.opacity = 0.95 * (1 - k*k*0.55);   // still bright when it lands
    if (k >= 1) {                          // reached blast radius → gone
      scene.remove(s.ring); s.ring.material.dispose();
      shockwaves.splice(i,1);
    }
  }
}

// ═══════════════════════════════════════════════════
// WORLD — two collider kinds, both flat (the game is 2D underneath a
// 3D presentation): axis-aligned BOXES (walls, blocks, house walls)
// and CIRCLES (tree trunks). Both block movement, bullets, and sight.
// All level geometry lives in worldGroup so a level swap is one wipe.
// ═══════════════════════════════════════════════════
const worldGroup = new THREE.Group();
scene.add(worldGroup);

const obstacles = [];       // {minX,maxX,minZ,maxZ}
const treeObstacles = [];   // {x,z,r}
let worldBounds = LEVELS[0].world;
let worldBorder = null;

// Tear down the previous level's meshes. Geometry is per-mesh (disposed
// here); materials are shared module-level constants in levels.js, so
// they are deliberately NOT disposed.
function clearWorld() {
  for (const child of worldGroup.children) child.geometry?.dispose();
  worldGroup.clear();
  obstacles.length = 0;
  treeObstacles.length = 0;
}

function buildWorld(def) {
  clearWorld();
  worldBounds = def.world;
  // Reseed first: generated geometry (groves) must come out identical
  // every time this level is built, so the map stays learnable.
  seedRandom(def.seed ?? 1);
  def.build({ worldGroup, boxes:obstacles, trees:treeObstacles });

  // visible world boundary — a red line so the edge is never a surprise
  const w = def.world;
  const pts = [
    new THREE.Vector3(w.minX, 0.15, w.minZ), new THREE.Vector3(w.maxX, 0.15, w.minZ),
    new THREE.Vector3(w.maxX, 0.15, w.maxZ), new THREE.Vector3(w.minX, 0.15, w.maxZ),
  ];
  worldBorder = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({ color:0xff3344, transparent:true, opacity:0.35 })
  );
  worldGroup.add(worldBorder);
}

// Circle (player/bullet) vs box, in the ground plane
function circleHitsBox(x, z, r, b) {
  const nx = clamp(x, b.minX, b.maxX);
  const nz = clamp(z, b.minZ, b.maxZ);
  const dx = x-nx, dz = z-nz;
  return dx*dx + dz*dz < r*r;
}
function circleHitsAnyObstacle(x, z, r) {
  for (const b of obstacles) if (circleHitsBox(x,z,r,b)) return true;
  for (const t of treeObstacles) {
    const dx = x-t.x, dz = z-t.z, rr = r+t.r;
    if (dx*dx + dz*dz < rr*rr) return true;
  }
  return false;
}

// Segment vs box (2D slab test) — used for line of sight
function segmentHitsBox(x1,z1, x2,z2, b) {
  const dx = x2-x1, dz = z2-z1;
  let tMin = 0, tMax = 1;
  for (const [p, d, lo, hi] of [[x1,dx,b.minX,b.maxX],[z1,dz,b.minZ,b.maxZ]]) {
    if (Math.abs(d) < 1e-9) { if (p < lo || p > hi) return false; }
    else {
      let t1 = (lo-p)/d, t2 = (hi-p)/d;
      if (t1 > t2) [t1,t2] = [t2,t1];
      tMin = Math.max(tMin, t1); tMax = Math.min(tMax, t2);
      if (tMin > tMax) return false;
    }
  }
  return true;
}

// Segment vs circle: closest point on the segment to the centre, with
// the parameter clamped to the segment's ends.
function segmentHitsCircle(x1,z1, x2,z2, c) {
  const dx = x2-x1, dz = z2-z1;
  const len2 = dx*dx + dz*dz;
  let t = len2 > 1e-9 ? ((c.x-x1)*dx + (c.z-z1)*dz)/len2 : 0;
  t = clamp(t, 0, 1);
  const px = x1 + dx*t, pz = z1 + dz*t;
  const ex = c.x-px, ez = c.z-pz;
  return ex*ex + ez*ez < c.r*c.r;
}

// Trees block sight as well as movement: a dense grove is a
// concealment corridor. (Acoustic detection ignores cover entirely.)
function hasLineOfSight(x1,z1, x2,z2) {
  for (const b of obstacles) if (segmentHitsBox(x1,z1,x2,z2,b)) return false;
  for (const t of treeObstacles) if (segmentHitsCircle(x1,z1,x2,z2,t)) return false;
  return true;
}

// ═══════════════════════════════════════════════════
// PLAYER — the FPV drone. A Group of sub-meshes, each with its
// own material (this is the per-part coloring the demo couldn't do).
// ═══════════════════════════════════════════════════
// Shape spec: SQUARE base with 4 CIRCLE motors at the corners.
// The whole group rotates to face movement direction; the glowing
// cyan pod marks the front so heading is readable from above.
// Local +Z is "forward".
const player = {
  group: new THREE.Group(),
  pos: LEVELS[0].playerStart.clone(),
  vel: new THREE.Vector3(),
  props: [],                          // spinning prop disks
  yaw: Math.PI,                       // faces up-screen at start
  alive: true,
};
{
  const g = player.group;
  g.rotation.order = 'YXZ';   // yaw first, then pitch — lean follows heading
  const frameMat = new THREE.MeshLambertMaterial({ color:0x22282c });
  // square base plate
  const body = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.4, 2.3), frameMat);
  g.add(body);
  // 4 circle motors at the corners + glowing prop disks on top
  for (const [sx,sz] of [[1,1],[1,-1],[-1,1],[-1,-1]]) {
    const motor = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 0.5, 16), frameMat);
    motor.position.set(sx*1.25, 0.2, sz*1.25);
    g.add(motor);
    const prop = new THREE.Mesh(
      new THREE.CylinderGeometry(0.85, 0.85, 0.05, 18),
      new THREE.MeshBasicMaterial({ color:0x22ff88, transparent:true, opacity:0.22,
        blending:THREE.AdditiveBlending, depthWrite:false })
    );
    prop.position.set(sx*1.25, 0.5, sz*1.25);
    g.add(prop);
    player.props.push(prop);
  }
  // camera pod — the drone's glowing "eye", marks the front (local +Z)
  const pod = new THREE.Mesh(new THREE.BoxGeometry(0.5,0.4,0.4),
    new THREE.MeshBasicMaterial({ color:0x00d2ff }));
  pod.position.set(0, 0.15, 1.1);
  g.add(pod);
  const podGlow = makeGlow(0x00d2ff, 3.2);
  podGlow.position.copy(pod.position);
  g.add(podGlow);
  scene.add(g);
}

// Blast radius ring — always visible, brightens when the kill is live.
const blastRing = new THREE.Mesh(
  new THREE.RingGeometry(CFG.player.blastRadius-0.5, CFG.player.blastRadius, 64),
  new THREE.MeshBasicMaterial({ color:0xff3344, transparent:true, opacity:0.10,
    blending:THREE.AdditiveBlending, depthWrite:false, side:THREE.DoubleSide })
);
blastRing.rotation.x = -Math.PI/2;
blastRing.position.y = 0.25;
scene.add(blastRing);

// ═══════════════════════════════════════════════════
// ENEMY — patrolling AA turret. Sub-parts: dark base, rotating
// turret, barrel, and the glowing amber core = the vulnerable-part
// glow language (for now the whole enemy dies, but the core is the
// visual promise).
// ═══════════════════════════════════════════════════
const enemy = {
  group:   new THREE.Group(),
  turret:  new THREE.Group(),
  core:    null, coreGlow: null,
  pos:     new THREE.Vector3(),
  aimAngle: 0,
  alive:   true,
  alerted: false,
  ammo:    CFG.enemy.burstRounds,
  fireTimer: 0,
  reloading: false,
  reloadTimer: 0,
  wpIndex: 0,
  pauseTimer: 0,
  hasLoS:  false,
  moveAngle: 0,    // direction of travel; the gun rests along it while unaware
  fleeing: false,  // backing away from the player while still shooting
  stuckTimer: 0,   // how long patrol has been unable to make progress
  waypoints: [],   // set per level
};
// Shape spec: a CIRCLE (head) with a STICK (gun). The gun and the
// glowing core live in `turret`, which rotates to the aim angle;
// bullets leave from the stick's far end (see enemyMuzzleWorld).
{
  const armorMat = new THREE.MeshLambertMaterial({ color:0x332e24 });
  // circle head
  const head = new THREE.Mesh(new THREE.CylinderGeometry(2.7, 2.9, 1.7, 28), armorMat);
  head.position.y = 0.85;
  enemy.group.add(head);
  // stick gun, extending along local +Z
  const gun = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 5.2), armorMat);
  gun.position.set(0, 1.3, 3.6);
  enemy.turret.add(gun);
  // glowing vulnerable core on top of the head
  enemy.core = new THREE.Mesh(new THREE.SphereGeometry(0.75, 12, 12),
    new THREE.MeshBasicMaterial({ color:0xffaa22 }));
  enemy.core.position.set(0, 2.1, 0);
  enemy.turret.add(enemy.core);
  enemy.coreGlow = makeGlow(0xffaa22, 6);
  enemy.coreGlow.position.copy(enemy.core.position);
  enemy.turret.add(enemy.coreGlow);
  enemy.group.add(enemy.turret);
  scene.add(enemy.group);
}

function enemyMuzzleWorld() {
  // far end of the gun stick: enemy position + aim direction * gun reach
  const dirX = Math.sin(enemy.aimAngle), dirZ = Math.cos(enemy.aimAngle);
  return { x: enemy.pos.x + dirX*6.2, y: 1.3, z: enemy.pos.z + dirZ*6.2 };
}

// Can the enemy body sit at (x,z) without clipping the world?
function enemyCanStand(x, z) {
  const w = worldBounds, m = CFG.enemy.bodyRadius + 2;
  if (x < w.minX+m || x > w.maxX-m || z < w.minZ+m || z > w.maxZ-m) return false;
  return !circleHitsAnyObstacle(x, z, CFG.enemy.bodyRadius);
}

// Is the whole path to a point walkable, not just its endpoint? Checking
// only the destination lets the enemy plan a route straight through a
// wall that happens to have open ground on the far side.
function enemyPathClear(angle, dist) {
  for (const f of [0.35, 0.7, 1.0]) {
    const d = dist*f;
    if (!enemyCanStand(enemy.pos.x + Math.sin(angle)*d,
                       enemy.pos.z + Math.cos(angle)*d)) return false;
  }
  return true;
}

// Pick a heading near `desired` whose path is clear, fanning outward to
// either side. Returns null only when every direction is blocked.
const STEER_FAN = [0, 0.5, -0.5, 1.0, -1.0, 1.5, -1.5, 2.1, -2.1, 2.7, -2.7];
function pickHeading(desired, dist) {
  for (const off of STEER_FAN) {
    const a = desired + off;
    if (enemyPathClear(a, dist)) return a;
  }
  return null;
}

// Move the enemy along a heading, sliding around obstacles. Returns the
// distance actually covered so the caller can tell it is making progress.
function enemyStep(angle, speed, dt) {
  const stepLen = speed*dt;
  for (const off of [0, 0.45, -0.45, 0.95, -0.95, 1.5, -1.5]) {
    const a = angle + off;
    const nx = enemy.pos.x + Math.sin(a)*stepLen;
    const nz = enemy.pos.z + Math.cos(a)*stepLen;
    if (enemyCanStand(nx, nz)) {
      enemy.pos.x = nx; enemy.pos.z = nz;
      enemy.moveAngle = a;
      return stepLen;
    }
  }
  return 0;   // pinned this frame
}

// Safety net: if the enemy ever ends up overlapping geometry (spawned
// badly, or a level rebuilt around it), walk it out to the nearest free
// spot instead of leaving it welded inside a wall.
function unstickEnemy() {
  if (enemyCanStand(enemy.pos.x, enemy.pos.z)) return false;
  for (let r = 2; r <= 60; r += 2) {
    for (let k = 0; k < 16; k++) {
      const a = k/16 * Math.PI*2;
      const x = enemy.pos.x + Math.cos(a)*r;
      const z = enemy.pos.z + Math.sin(a)*r;
      if (enemyCanStand(x, z)) { enemy.pos.x = x; enemy.pos.z = z; return true; }
    }
  }
  return false;
}

function updateEnemy(dt) {
  if (!enemy.alive) return;
  const e = CFG.enemy;

  // ── Detection: acoustic. Inside the radius it knows where you
  //    are, walls or not. The moment of first detection is flagged. ──
  const pdx = player.pos.x-enemy.pos.x, pdz = player.pos.z-enemy.pos.z;
  const pdist = Math.hypot(pdx, pdz);
  const inRange = pdist < e.detectRadius && state === S.FLYING;
  if (inRange && !enemy.alerted) {
    enemy.alerted = true;
    flash('ACOUSTIC SIGNATURE DETECTED', '#ff8800');
  }
  if (!inRange) enemy.alerted = false;   // drifts back to patrol if you retreat

  // ── Movement: flee if the drone is closing, else patrol ──
  // Every move goes through enemyStep, which refuses to enter geometry
  // and slides along it instead. (Patrol used to move without any
  // collision check, which is how the enemy ended up embedded in a
  // wall and then had nowhere legal to retreat to.)
  unstickEnemy();
  enemy.fleeing = enemy.alerted && pdist < e.fleeRadius;

  if (enemy.fleeing) {
    // Back away from the player. It keeps shooting while retreating
    // (the aim code below is unchanged), so fleeing is kiting, not
    // disengaging. If every direction is blocked it stands and fights.
    const away = Math.atan2(-pdx, -pdz);
    const heading = pickHeading(away, e.fleeProbe) ?? away;
    enemyStep(heading, e.fleeSpeed, dt);
    enemy.pauseTimer = 0;
    enemy.stuckTimer = 0;
  } else {
    // ── Patrol: walk waypoint to waypoint, pause at each ──
    const wp = enemy.waypoints[enemy.wpIndex];
    if (enemy.pauseTimer > 0) {
      enemy.pauseTimer -= dt;
      enemy.stuckTimer = 0;
    } else if (wp) {
      const dx = wp.x-enemy.pos.x, dz = wp.z-enemy.pos.z;
      const d = Math.hypot(dx, dz);
      if (d < 2.5) {
        enemy.pauseTimer = e.waypointPause;
        enemy.wpIndex = (enemy.wpIndex+1) % enemy.waypoints.length;
        enemy.stuckTimer = 0;
      } else {
        const want = Math.atan2(dx, dz);
        const heading = pickHeading(want, Math.min(d, e.fleeProbe)) ?? want;
        const moved = enemyStep(heading, e.moveSpeed, dt);
        // If it cannot make progress for a while (fleeing left it behind
        // an obstacle, say), give up on this waypoint and try the next
        // one rather than grinding against a wall forever.
        enemy.stuckTimer = moved > 0 ? 0 : enemy.stuckTimer + dt;
        if (enemy.stuckTimer > 1.5) {
          enemy.wpIndex = (enemy.wpIndex+1) % enemy.waypoints.length;
          enemy.stuckTimer = 0;
        }
      }
    }
  }
  enemy.group.position.copy(enemy.pos);

  // ── Turret aim ──
  let targetAngle;
  if (enemy.alerted) {
    targetAngle = Math.atan2(pdx, pdz);       // tracks you through walls
  } else {
    targetAngle = enemy.moveAngle;             // rests along travel direction
  }
  let diff = targetAngle - enemy.aimAngle;
  while (diff >  Math.PI) diff -= Math.PI*2;
  while (diff < -Math.PI) diff += Math.PI*2;
  const step = clamp(diff, -e.turnRate*dt, e.turnRate*dt);
  enemy.aimAngle += step;
  enemy.turret.rotation.y = enemy.aimAngle;

  // ── Shooting: needs alert + line of sight + aimed + ammo ──
  enemy.hasLoS = enemy.alerted && hasLineOfSight(enemy.pos.x, enemy.pos.z, player.pos.x, player.pos.z);

  if (enemy.reloading) {
    enemy.reloadTimer -= dt;
    // core pulses fast while reloading = "window open" signal
    const p = 1 + Math.sin(performance.now()*0.02)*0.5;
    enemy.coreGlow.scale.set(6*p, 6*p, 1);
    if (enemy.reloadTimer <= 0) {
      enemy.reloading = false;
      enemy.ammo = e.burstRounds;
    }
    return;
  }
  enemy.coreGlow.scale.set(6,6,1);

  enemy.fireTimer -= dt;
  const aimed = Math.abs(diff) < e.aimTolerance;
  if (enemy.hasLoS && aimed && enemy.fireTimer <= 0 && state === S.FLYING) {
    fireBullet();
    enemy.ammo--;
    enemy.fireTimer = e.fireDelay;
    if (enemy.ammo <= 0) {
      enemy.reloading = true;
      enemy.reloadTimer = e.reloadTime;
    }
  }
}

// ═══════════════════════════════════════════════════
// SHAHED — the intercept-mode target. Flies a straight run down the
// corridor at altitude, weaving, ignoring every obstacle. You cannot
// out-fly it by going around: you are faster, but you fly low.
//
// KEY READABILITY TRICK: it is 15 units up while the camera looks
// straight down, so its sprite sits far from where it actually is in
// plan view. A dark SHADOW BLOB on the ground tracks its x/z — that
// blob, not the aircraft, is what you line up your blast with.
// ═══════════════════════════════════════════════════
const shahed = {
  group:  new THREE.Group(),
  shadow: null,
  pos:    new THREE.Vector3(),
  baseX:  0,          // weave centre
  t:      0,          // own clock, drives the weave
  alive:  false,      // only active in intercept levels
  escapeZ: -9999,
};
{
  const bodyMat = new THREE.MeshLambertMaterial({ color:0x2b2f33 });
  // delta wing: a flat triangle, wide and swept (reads at a glance
  // from directly above, which is the only angle that matters)
  const wingShape = new THREE.Shape();
  wingShape.moveTo(0, 5.5);      // nose (local +Z)
  wingShape.lineTo(7.5, -4.5);   // right tip
  wingShape.lineTo(2.2, -3.2);
  wingShape.lineTo(0, -4.8);     // tail notch
  wingShape.lineTo(-2.2, -3.2);
  wingShape.lineTo(-7.5, -4.5);  // left tip
  wingShape.closePath();
  const wing = new THREE.Mesh(
    new THREE.ExtrudeGeometry(wingShape, { depth:0.7, bevelEnabled:false }), bodyMat);
  wing.rotation.x = Math.PI/2;   // lay the extrusion flat
  shahed.group.add(wing);
  // fuselage spine + vertical fin, so it is not a flat card in 3D
  const spine = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.4, 9), bodyMat);
  spine.position.set(0, 0.5, 0.5);
  shahed.group.add(spine);
  const fin = new THREE.Mesh(new THREE.BoxGeometry(0.4, 2.6, 2.4), bodyMat);
  fin.position.set(0, 1.8, -3.6);
  shahed.group.add(fin);
  // engine glow at the tail — the only bright part (glow = important)
  const engine = new THREE.Mesh(new THREE.SphereGeometry(0.9, 10, 10),
    new THREE.MeshBasicMaterial({ color:0xff5522 }));
  engine.position.set(0, 0.7, -4.9);
  shahed.group.add(engine);
  const engineGlow = makeGlow(0xff5522, 7);
  engineGlow.position.copy(engine.position);
  shahed.group.add(engineGlow);
  scene.add(shahed.group);

  // ground shadow — the thing you actually aim at
  shahed.shadow = new THREE.Mesh(
    new THREE.CircleGeometry(4.2, 28),
    new THREE.MeshBasicMaterial({ color:0x000000, transparent:true, opacity:0.55 })
  );
  shahed.shadow.rotation.x = -Math.PI/2;
  shahed.shadow.position.y = 0.12;
  scene.add(shahed.shadow);
}

function updateShahed(dt, tAbs) {
  if (!shahed.alive) return;
  const S_ = CFG.shahed;
  // It only starts its run once you launch — standing in READY should
  // not cost you ground.
  if (state !== S.FLYING) {
    shahed.group.position.copy(shahed.pos);
    return;
  }
  shahed.t += dt;
  shahed.pos.z -= S_.speed * dt;
  // sinusoidal weave around the corridor centreline
  shahed.pos.x = shahed.baseX + Math.sin(shahed.t * Math.PI*2 / S_.weavePeriod) * S_.weaveAmp;
  shahed.pos.y = S_.altitude + Math.sin(tAbs*1.4)*0.6;

  // Bank into the weave. `lateral` is the sign of the sideways velocity
  // (+ = drifting toward +X). SIGNS ARE COUNTER-INTUITIVE HERE: the body
  // sits at yaw π, and with Three's default XYZ order the roll is applied
  // in the body frame *before* that 180° yaw — which mirrors how the roll
  // reads in world space. Banking into a turn toward +X therefore needs a
  // POSITIVE rotation.z, and yawing the nose toward +X needs π MINUS the
  // offset. (Verified against the rotation matrices; getting either sign
  // backwards makes it lean out of its turns.)
  const lateral = Math.cos(shahed.t * Math.PI*2 / S_.weavePeriod);
  shahed.group.position.copy(shahed.pos);
  shahed.group.rotation.z = lateral * 0.45;
  shahed.group.rotation.y = Math.PI - lateral * 0.12;   // nose points -Z

  shahed.shadow.position.x = shahed.pos.x;
  shahed.shadow.position.z = shahed.pos.z;
  // shadow tightens as it flies lower... it doesn't, but scaling it
  // slightly with the bob keeps it feeling attached
  const s = 1 + Math.sin(tAbs*1.4)*0.03;
  shahed.shadow.scale.set(s, s, 1);

  // reached the city → mission failed
  if (state === S.FLYING && shahed.pos.z <= shahed.escapeZ) {
    shahedEscaped();
  }
}

// ═══════════════════════════════════════════════════
// BULLETS — glowing tracers in a plain array.
// ═══════════════════════════════════════════════════
const bullets = [];   // { mesh, glow, vx, vz }
const bulletGeo = new THREE.SphereGeometry(0.3, 6, 6);
const bulletMat = new THREE.MeshBasicMaterial({ color:0xffcc66 });

function fireBullet() {
  const m = enemyMuzzleWorld();
  // Averaging two randoms gives a triangular (bell-ish) distribution:
  // clustered near zero, tapering toward the edges of the cone.
  const t = (Math.random() + Math.random()) - 1;        // -1..1, peaked at 0
  const ang = enemy.aimAngle + t * CFG.enemy.spreadDeg * Math.PI/180;
  const speed = CFG.enemy.bulletSpeed * (1 + (Math.random()*2-1)*CFG.enemy.speedJitter);
  const mesh = new THREE.Mesh(bulletGeo, bulletMat);
  mesh.position.set(m.x, m.y, m.z);
  const glow = makeGlow(0xffaa44, 2.4);
  mesh.add(glow);
  scene.add(mesh);
  bullets.push({ mesh,
    vx: Math.sin(ang)*speed,
    vz: Math.cos(ang)*speed });
  // muzzle flash
  // muzzle flash: directional, so it sprays along the gun rather than
  // in a full circle — spreadDeg here is the sideways scatter
  const F = CFG.fx.muzzle;
  for (let i=0;i<F.count;i++) {
    const s = lerp(F.speed[0], F.speed[1], Math.random());
    const a = ang + (Math.random()-.5)*2*F.spreadDeg*DEG;
    sparkPool.spawn(m.x, m.y, m.z,
      Math.sin(a)*s, (Math.random()-.3)*2, Math.cos(a)*s,
      lerp(F.life[0], F.life[1], Math.random()), 1, 0.7, 0.2, PHYS.SPARK);
  }
}

function removeBullet(i) {
  scene.remove(bullets[i].mesh);
  bullets.splice(i, 1);
}

function updateBullets(dt) {
  for (let i=bullets.length-1;i>=0;i--) {
    const b = bullets[i];
    b.mesh.position.x += b.vx*dt;
    b.mesh.position.z += b.vz*dt;
    const bx = b.mesh.position.x, bz = b.mesh.position.z;

    // out of world
    const w = worldBounds;
    if (bx < w.minX-20 || bx > w.maxX+20 || bz < w.minZ-20 || bz > w.maxZ+20) { removeBullet(i); continue; }

    // obstacle hit → sparks
    if (circleHitsAnyObstacle(bx, bz, 0.3)) {
      // ricochet: scatter cone, pushed back along the impact direction
      const R = CFG.fx.ricochet;
      for (let k=0;k<R.count;k++) {
        const v = sprayVelocity(lerp(R.speed[0], R.speed[1], Math.random()),
                                R.spreadDeg*DEG, _spray);
        sparkPool.spawn(bx, b.mesh.position.y, bz,
          v.x - b.vx*0.12, v.y, v.z - b.vz*0.12,
          lerp(R.life[0], R.life[1], Math.random()), 1, 0.6, 0.2, PHYS.SPARK);
      }
      removeBullet(i); continue;
    }

    // player hit → detonate in place (the blast still counts!)
    if (state === S.FLYING &&
        Math.hypot(bx-player.pos.x, bz-player.pos.z) < CFG.player.radius+0.4) {
      removeBullet(i);
      detonate('SHOT DOWN');
      continue;
    }
  }
}

// ═══════════════════════════════════════════════════
// EXPLOSIONS + OUTCOME
// Any player explosion, however caused, resolves the level:
// enemy inside blast radius → win, outside → restart.
// ═══════════════════════════════════════════════════
let boomTimer = 0;         // real-time countdown of the cinematic
let boomPoint = new THREE.Vector3();
let pendingWin = false;
let enemyBoomDelay = 0;

function detonate(cause) {
  if (state !== S.FLYING) return;
  boomPoint.copy(player.pos);
  explodeDrone(player.pos.x, player.pos.y, player.pos.z, 1.0);
  player.group.visible = false;
  player.alive = false;

  // Did the blast take the mission target with it? Always HORIZONTAL
  // distance — in intercept mode you detonate beneath the Shahed, so its
  // altitude must not count against you.
  const target = M.target();
  const d = Math.hypot(target.pos.x-player.pos.x, target.pos.z-player.pos.z);
  pendingWin = target.alive && d <= M.killRadius();
  enemyBoomDelay = pendingWin ? 0.22 : -1;   // target pops shortly after you

  setState(S.BOOM);
  boomTimer = CFG.cam.boomTime;
  timeScale = CFG.cam.freezeScale;   // freeze on the shattered silhouette
  shake = 1.2;
  flash(cause, pendingWin ? '#ffd700' : '#ff2200');
}

// Intercept-only loss: the Shahed crossed the city line. The player is
// still flying, so this is a clean fail with no detonation.
function shahedEscaped() {
  shahed.alive = false;
  setState(S.FAIL);
  flash('TARGET REACHED THE CITY', '#ff2200');
  failTimer = CFG.failRestartDelay;
}

function updateBoom(rdt) {  // rdt = REAL dt: the cinematic runs on real time
  boomTimer -= rdt;
  // Three beats: a near-freeze while the object hangs in the air as a
  // cloud of its own dots, then slow motion as it comes apart, then back
  // to normal speed.
  const elapsed = CFG.cam.boomTime - boomTimer;
  if (elapsed < CFG.cam.freezeTime) {
    timeScale = CFG.cam.freezeScale;
  } else {
    timeScale = lerp(timeScale, boomTimer > 0.5 ? CFG.cam.boomSlowmo : 1, rdt*2);
  }

  if (enemyBoomDelay >= 0) {
    enemyBoomDelay -= rdt;
    if (enemyBoomDelay < 0 && M.target().alive) {
      M.destroyTarget();
      shake = 1.6;
    }
  }

  if (boomTimer <= 0) {
    timeScale = 1;
    if (pendingWin) {
      setState(S.WIN);
      flash('TARGET DESTROYED', '#ffd700');
    } else {
      setState(S.FAIL);
      flash('TARGET INTACT — RESTARTING', '#ff2200');
      failTimer = CFG.failRestartDelay;
    }
  }
}

// ═══════════════════════════════════════════════════
// CAMERA — follows the player from above with a slight tilt.
// During BOOM it dives toward the explosion. `shake` decays.
// ═══════════════════════════════════════════════════
const camLook  = LEVELS[0].playerStart.clone();
const camFocus = new THREE.Vector3();   // where the camera wants to centre
const camLead  = new THREE.Vector3();   // current look-ahead offset
let leadCharge = 0;                     // 0..1, how much lead is engaged
let shake = 0;

// ── Look-ahead ──
// At speed the drone outruns what the camera shows: obstacles arrive with
// no time to react. So the camera slides ahead along the direction of
// travel. It eases in between `leadFrom` and `leadFull` of top speed and
// is rate-limited by `leadRampIn`/`leadRampOut`, so it never snaps — a
// camera that jumps ahead the instant you touch full throttle is worse
// than no lead at all.
function updateLead(rdt) {
  const c = CFG.cam;
  const speed = Math.hypot(player.vel.x, player.vel.z);
  const frac  = speed / CFG.player.maxSpeed;
  const want  = clamp((frac - c.leadFrom) / (c.leadFull - c.leadFrom), 0, 1);
  // rate-limit the charge so it takes leadRampIn seconds to reach full
  const rate = want > leadCharge ? rdt/c.leadRampIn : -rdt/c.leadRampOut;
  leadCharge = clamp(leadCharge + clamp(want-leadCharge, -Math.abs(rate), Math.abs(rate)), 0, 1);
  const ease = leadCharge*leadCharge*(3-2*leadCharge);   // smoothstep
  const tx = speed > 0.5 ? player.vel.x/speed * c.leadDistance * ease : 0;
  const tz = speed > 0.5 ? player.vel.z/speed * c.leadDistance * ease : 0;
  // smooth the vector itself too, so hard turns swing the view around
  // rather than flicking it
  camLead.x = lerp(camLead.x, tx, c.leadLerp);
  camLead.z = lerp(camLead.z, tz, c.leadLerp);
}

// Fills camFocus and returns the height the camera should sit at.
function computeCamFocus() {
  if (state === S.BOOM || state === S.WIN) {
    camFocus.copy(boomPoint);
    return CFG.cam.boomHeight;
  }
  camFocus.set(player.pos.x + camLead.x, player.pos.y, player.pos.z + camLead.z);
  return CFG.cam.height;
}

function updateCamera(rdt) {
  updateLead(rdt);
  const height = computeCamFocus();
  camLook.lerp(camFocus, CFG.cam.followLerp);
  shake = Math.max(shake - rdt*2.5, 0);
  const sx = (Math.random()-.5)*shake*2, sz = (Math.random()-.5)*shake*2;
  camera.position.set(
    camLook.x + sx,
    lerp(camera.position.y, height, 0.05),
    camLook.z + CFG.cam.backoff + sz
  );
  camera.lookAt(camLook.x, 0, camLook.z);
}

// Place the camera exactly, with no easing. Used whenever the level
// (re)starts: lerping in from wherever the last run ended wastes the
// first second of a retry and disorients more than it smooths.
function snapCamera() {
  camLead.set(0,0,0);
  leadCharge = 0;
  shake = 0;
  const height = computeCamFocus();
  camLook.copy(camFocus);
  camera.position.set(camLook.x, height, camLook.z + CFG.cam.backoff);
  camera.lookAt(camLook.x, 0, camLook.z);
}

// ═══════════════════════════════════════════════════
// INPUT — FLOATING virtual joystick with a bounded zone.
// The first touch plants a HOME point and starts the run. The stick's
// anchor follows the finger once it passes the rim, so reversing after a
// long swipe stays quick — but the anchor is penned inside `joyZone`
// pixels of home, so the stick can never wander up the screen.
//
// Once the anchor is pinned against the zone edge, extra finger travel
// only steers: the magnitude is capped, the knob sits on the rim and the
// ring lights up. That is the fix for the original confusion, where a
// stick sliding endlessly up the screen implied speed that was not there.
//
// Screen up = world -Z (up the map). Finger near the anchor = hover.
// RELEASE = DETONATE.
// ═══════════════════════════════════════════════════
let activePointer = null;
let touching = false;
const joy = { hx:0, hy:0,        // home — where the first touch landed
              ax:0, ay:0,        // anchor — floats, but stays inside the zone
              fx:0, fy:0,        // finger (screen px)
              x:0,  y:0,         // output vector, each -1..1, deadzone applied
              saturated:false }; // at full deflection — drives the HUD cue

function updateJoystick() {
  const R = CFG.player.joyRadius, Z = CFG.player.joyZone;
  let dx = joy.fx-joy.ax, dy = joy.fy-joy.ay;
  let d = Math.hypot(dx, dy);

  if (d > R) {
    // trail the anchor behind the finger, then pull it back inside the zone
    let ax = joy.fx - dx/d*R, ay = joy.fy - dy/d*R;
    const zx = ax-joy.hx, zy = ay-joy.hy;
    const zd = Math.hypot(zx, zy);
    if (zd > Z) { ax = joy.hx + zx/zd*Z; ay = joy.hy + zy/zd*Z; }
    joy.ax = ax; joy.ay = ay;
    dx = joy.fx-joy.ax; dy = joy.fy-joy.ay;
    d = Math.hypot(dx, dy);
  }

  if (d < CFG.player.joyDeadzone) {
    joy.x = 0; joy.y = 0; joy.saturated = false;
    return;
  }
  // direction from the angle, magnitude from the distance capped at the
  // rim — past the rim the stick only steers, and says so.
  const mag = Math.min(d, R) / R;
  joy.x = dx/d * mag;
  joy.y = dy/d * mag;
  joy.saturated = d >= R;
}

canvas.addEventListener('pointerdown', e => {
  if (state === S.MENU) return;            // menu buttons own the input
  if (activePointer !== null) return;      // first finger only
  activePointer = e.pointerId;
  canvas.setPointerCapture(e.pointerId);
  // after a win, a tap goes back to mission select; after a fail the
  // level auto-restarts, and a tap just restarts it sooner
  if (state === S.WIN)  { openMenu(); return; }
  if (state === S.FAIL) { resetLevel(); return; }
  touching = true;
  joy.hx = joy.ax = joy.fx = e.clientX;   // home + anchor start together
  joy.hy = joy.ay = joy.fy = e.clientY;
  joy.x = joy.y = 0;
  joy.saturated = false;
  if (state === S.READY) {
    setState(S.FLYING);
    hintEl.classList.add('off');
  }
});
canvas.addEventListener('pointermove', e => {
  if (e.pointerId !== activePointer || !touching) return;
  joy.fx = e.clientX; joy.fy = e.clientY;
  updateJoystick();
});
function pointerEnd(e) {
  if (e.pointerId !== activePointer) return;
  activePointer = null;
  touching = false;
  joy.x = joy.y = 0;
  joy.saturated = false;
  if (state === S.FLYING) detonate('DETONATED');
}
canvas.addEventListener('pointerup', pointerEnd);
canvas.addEventListener('pointercancel', pointerEnd);

// ═══════════════════════════════════════════════════
// SHATTER CLOUDS — sampled once, now that every entity mesh exists.
// A little more than the largest shatter count so the emitters can pick
// a different subset each time and repeat kills do not look identical.
// ═══════════════════════════════════════════════════
droneCloud  = buildPointCloud(player.group, 700);
enemyCloud  = buildPointCloud(enemy.group,  900);
shahedCloud = buildPointCloud(shahed.group, 800);

// ═══════════════════════════════════════════════════
// MODES — the only place that knows how the game modes differ.
//
// Everything else in this file (camera, particles, input, HUD chrome,
// outcome cinematic, main loop) is shared and must stay mode-agnostic.
// A mode answers a small fixed set of questions:
//
//   target()        the thing the player has to destroy — any object
//                   with .pos and .alive
//   killRadius()    how close the blast must be, horizontally
//   markerHeight    height to project the HUD marker at (the Shahed is
//                   marked at its shadow, not at the aircraft)
//   enter(def)      one-time setup when the level loads
//   reset(def)      per-attempt entity reset
//   update(dt)      advance this mode's entities
//   destroyTarget() kill + explode the target after a successful blast
//   marker()        {label, color, alpha} for the on-screen target marker
//   markerExtras()  optional extra drawing next to that marker
//   status(inKill)  {text, color} for the third HUD status line
//
// Adding a mode = adding an entry here plus whatever entity it drives.
// It should not require touching the HUD, the outcome logic or the loop.
// ═══════════════════════════════════════════════════
const MODES = {
  strike: {
    id: 'strike',
    target:      () => enemy,
    killRadius:  () => CFG.player.blastRadius,
    markerHeight: 6,

    enter(def) {
      enemy.waypoints = def.enemy?.waypoints ?? [];
      enemy.group.visible = true;
      shahed.group.visible = false;
      shahed.shadow.visible = false;
    },
    reset() {
      const wps = enemy.waypoints;
      enemy.pos.copy(wps[wps.length-1] ?? new THREE.Vector3());
      enemy.wpIndex = 0;
      enemy.alive = true;
      enemy.group.visible = true;
      enemy.alerted = false;
      enemy.fleeing = false;
      enemy.ammo = CFG.enemy.burstRounds;
      enemy.reloading = false;
      enemy.fireTimer = 0;
      enemy.pauseTimer = 0;
      enemy.stuckTimer = 0;
      enemy.hasLoS = false;
      unstickEnemy();          // in case a waypoint sits too near geometry
      shahed.alive = false;
    },
    update(dt) { updateEnemy(dt); },
    destroyTarget() {
      enemy.alive = false;
      enemy.group.visible = false;
      explodeEnemy(enemy.pos.x, 2, enemy.pos.z, 1.6);
    },
    marker() {
      if (enemy.reloading) return { label:'RELOADING', color:'#ffd700', alpha:0.9 };
      if (enemy.hasLoS)    return { label:'FIRING',    color:'#ff3344', alpha:0.9 };
      if (enemy.fleeing)   return { label:'EVADING',   color:'#ff8800', alpha:0.9 };
      if (enemy.alerted)   return { label:'ALERT',     color:'#ff8800', alpha:0.9 };
      return { label:'UNAWARE', color:'#557788', alpha:0.55 };
    },
    // ammo / reload bar above the turret
    markerExtras(p, color) {
      const bw = 46, bh = 4;
      const frac = enemy.reloading
        ? 1 - enemy.reloadTimer/CFG.enemy.reloadTime          // reload progress
        : enemy.ammo/CFG.enemy.burstRounds;                   // rounds left
      octx.strokeStyle = 'rgba(255,255,255,0.25)';
      octx.strokeRect(p.x-bw/2, p.y-20, bw, bh);
      octx.fillStyle = color;
      octx.fillRect(p.x-bw/2, p.y-20, bw*frac, bh);
    },
    status(inKill) {
      return inKill ? { text:'>> IN RANGE — RELEASE <<', color:'#33ff77' }
                    : { text:'', color:'#33ff77' };
    },
  },

  intercept: {
    id: 'intercept',
    target:      () => shahed,
    killRadius:  () => CFG.player.blastRadius * CFG.shahed.catchFactor,
    markerHeight: 0.5,        // mark the shadow on the ground, not the aircraft

    enter(def) {
      enemy.group.visible = false;
      shahed.group.visible = true;
      shahed.shadow.visible = true;
    },
    reset(def) {
      const s = def.shahed;
      shahed.pos.copy(s.start);
      shahed.pos.y = CFG.shahed.altitude;
      shahed.baseX = s.start.x;
      shahed.escapeZ = s.escapeZ;
      shahed.t = 0;
      shahed.alive = true;
      shahed.group.visible = true;
      shahed.shadow.visible = true;
      shahed.group.position.copy(shahed.pos);
      shahed.shadow.position.set(shahed.pos.x, 0.12, shahed.pos.z);
      enemy.alive = false;
      enemy.alerted = false;
      enemy.hasLoS = false;
    },
    update(dt, t) { updateShahed(dt, t); },
    destroyTarget() {
      shahed.alive = false;
      shahed.group.visible = false;
      shahed.shadow.visible = false;
      explodeShahed(shahed.pos.x, shahed.pos.y, shahed.pos.z, 1.5);
    },
    marker() { return { label:'SHAHED-136', color:'#ff5533', alpha:0.9 }; },
    // a line from the aircraft down to its shadow, so the altitude
    // offset is unmistakable
    markerExtras(p) {
      const air = project(shahed.pos.x, shahed.pos.y, shahed.pos.z);
      octx.strokeStyle = 'rgba(255,85,51,0.35)';
      octx.lineWidth = 1;
      octx.beginPath();
      octx.moveTo(air.x, air.y); octx.lineTo(p.x, p.y);
      octx.stroke();
    },
    status(inKill) {
      if (!shahed.alive) return { text:'', color:'#33ff77' };
      if (inKill) return { text:'>> BENEATH TARGET — RELEASE <<', color:'#33ff77' };
      const toCity = Math.max(shahed.pos.z - shahed.escapeZ, 0);
      return { text: `CITY IN: ${(toCity*2.5).toFixed(0)}m`,
               color: toCity < 260 ? '#ff3344' : 'rgba(255,255,255,0.5)' };
    },
  },
};

// ═══════════════════════════════════════════════════
// HUD — DOM status lines + flash, and a 2D overlay canvas
// for markers that track world objects (target state + extras).
// ═══════════════════════════════════════════════════
const sLine1 = document.getElementById('sLine1');
const sLine2 = document.getElementById('sLine2');
const sLine3 = document.getElementById('sLine3');
const flashEl = document.getElementById('flash');
let flashCd = 0;

function flash(txt, color) {
  flashEl.textContent = txt;
  flashEl.style.color = color || '#fff';
  flashEl.classList.add('on');
  flashCd = 2.2;
}

const oc = document.getElementById('overlay');
const octx = oc.getContext('2d');
function resizeOverlay(){ oc.width = innerWidth; oc.height = innerHeight; }
resizeOverlay();

function project(wx,wy,wz) {
  const v = new THREE.Vector3(wx,wy,wz).project(camera);
  return { x:(v.x*.5+.5)*innerWidth, y:(-.5*v.y+.5)*innerHeight, z:v.z };
}

function drawOverlay() {
  octx.clearRect(0,0,oc.width,oc.height);

  // ── virtual joystick ──
  // A dashed circle shows the zone the stick may drift inside; the solid
  // ring is the stick itself. At full deflection the knob sits on the rim
  // and the ring brightens: "this is as fast as it gets".
  if (touching && state === S.FLYING) {
    const R = CFG.player.joyRadius, Z = CFG.player.joyZone;
    const sat = joy.saturated;

    // the bounded movement zone, drawn around home
    octx.strokeStyle = 'rgba(0,210,255,0.14)';
    octx.lineWidth = 1;
    octx.setLineDash([5,7]);
    octx.beginPath(); octx.arc(joy.hx, joy.hy, Z, 0, Math.PI*2); octx.stroke();
    octx.setLineDash([]);

    octx.fillStyle = 'rgba(0,210,255,0.08)';
    octx.beginPath(); octx.arc(joy.ax, joy.ay, R, 0, Math.PI*2); octx.fill();
    octx.strokeStyle = sat ? 'rgba(0,230,255,0.75)' : 'rgba(0,210,255,0.25)';
    octx.lineWidth = sat ? 3 : 1.5;
    octx.beginPath(); octx.arc(joy.ax, joy.ay, R, 0, Math.PI*2); octx.stroke();

    // dot at the stick's centre, so its drift is legible
    octx.fillStyle = 'rgba(0,210,255,0.35)';
    octx.beginPath(); octx.arc(joy.ax, joy.ay, 3, 0, Math.PI*2); octx.fill();

    // stem from centre to knob — shows how much stick is being used
    const kx = joy.ax + joy.x*R, ky = joy.ay + joy.y*R;
    octx.strokeStyle = 'rgba(0,210,255,0.30)';
    octx.lineWidth = 2;
    octx.beginPath(); octx.moveTo(joy.ax, joy.ay); octx.lineTo(kx, ky); octx.stroke();

    octx.fillStyle = sat ? 'rgba(0,235,255,0.85)' : 'rgba(0,210,255,0.55)';
    octx.beginPath(); octx.arc(kx, ky, sat ? 16 : 14, 0, Math.PI*2); octx.fill();
  }

  // ── target marker: the mode says who the target is and how it reads ──
  const target = M.target();
  if (!target.alive) return;
  const p = project(target.pos.x, M.markerHeight, target.pos.z);
  if (p.z >= 1) return;

  const { label, color, alpha } = M.marker();
  const onScreen = p.x > 0 && p.x < oc.width && p.y > 0 && p.y < oc.height;

  if (!onScreen) {
    // ── off-screen indicator: chevron at the screen edge pointing
    //    toward the enemy, with distance — so you always know where
    //    the threat is before it can see you ──
    const pp = project(player.pos.x, 0, player.pos.z);   // ≈ screen center
    const ang = Math.atan2(p.y-pp.y, p.x-pp.x);
    const m = 46;   // margin from screen edge
    const cx = clamp(p.x, m, oc.width-m);
    const cy = clamp(p.y, m, oc.height-m);

    octx.save();
    octx.translate(cx, cy);
    octx.rotate(ang);
    octx.fillStyle = color;
    octx.globalAlpha = alpha;
    octx.beginPath();                    // chevron pointing along +x (= toward enemy)
    octx.moveTo(12, 0); octx.lineTo(-6, -8); octx.lineTo(-2, 0); octx.lineTo(-6, 8);
    octx.closePath(); octx.fill();
    octx.restore();

    const d = Math.hypot(target.pos.x-player.pos.x, target.pos.z-player.pos.z);
    octx.font = "9px 'Courier New'";
    octx.textAlign = 'center';
    octx.fillStyle = color;
    octx.globalAlpha = 0.8;
    octx.fillText(`${(d*2.5).toFixed(0)}m`, cx, cy+20);
    octx.globalAlpha = 1;
    return;   // label/ammo bar would be off-screen anyway
  }

  octx.font = "9px 'Courier New'";
  octx.textAlign = 'center';
  octx.fillStyle = color;
  octx.fillText(label, p.x, p.y - 26);
  M.markerExtras?.(p, color);
}

function updateHUD() {
  const target = M.target();
  const d = Math.hypot(target.pos.x-player.pos.x, target.pos.z-player.pos.z);
  const inKill = target.alive && d <= M.killRadius();

  sLine1.textContent = STATE_LABEL[state];
  sLine2.textContent = target.alive ? `DIST: ${(d*2.5).toFixed(0)}m` : 'DIST: —';
  const st = M.status(inKill && state === S.FLYING);
  sLine3.textContent = st.text;
  sLine3.style.color = st.color;

  // blast ring feedback: dim red normally, bright green when the kill is live
  blastRing.position.x = player.pos.x;
  blastRing.position.z = player.pos.z;
  if (inKill && state === S.FLYING) {
    blastRing.material.color.setHex(0x33ff77);
    blastRing.material.opacity = 0.35 + Math.sin(performance.now()*0.012)*0.15;
  } else {
    blastRing.material.color.setHex(0xff3344);
    blastRing.material.opacity = state === S.FLYING ? 0.10 : 0.04;
  }
}

// ═══════════════════════════════════════════════════
// GAME STATE
// ═══════════════════════════════════════════════════
const S = { MENU:0, READY:1, FLYING:2, BOOM:3, WIN:4, FAIL:5 };
const STATE_LABEL = ['// MENU','// STANDBY','// AIRBORNE','// IMPACT',
                     '// MISSION COMPLETE','// MISSION FAILED'];
let state = S.MENU;
let failTimer = 0;
let timeScale = 1;

let level = LEVELS[0];        // current level definition
let M     = MODES[level.mode]; // active mode hooks — see the MODES section

function setState(s) { state = s; }

const menuEl  = document.getElementById('menu');
const hintEl  = document.getElementById('hint');

// Build the level: geometry, colliders, entities, then park in READY.
function loadLevel(def) {
  level = def;
  M = MODES[def.mode];
  if (!M) throw new Error(`level "${def.id}" uses unknown mode "${def.mode}"`);
  buildWorld(def);
  M.enter(def);

  resetLevel();          // ends with a hard camera snap
}

function resetLevel() {
  player.pos.copy(level.playerStart);
  player.vel.set(0,0,0);
  player.yaw = Math.PI;
  player.alive = true;
  player.group.visible = true;
  player.group.position.copy(player.pos);   // updatePlayer is idle until FLYING

  M.reset(level);

  for (let i=bullets.length-1;i>=0;i--) removeBullet(i);
  burstPool.clear(); sparkPool.clear(); trailPool.clear();
  smokePool.clear(); shardPool.clear();
  timeScale = 1;
  hintEl.classList.remove('off');
  setState(S.READY);
  snapCamera();          // no easing in from wherever the last run ended
}

function openMenu() {
  setState(S.MENU);
  menuEl.classList.remove('off');
  timeScale = 1;
}

// Level buttons are generated from LEVELS so adding a mission is a
// levels.js edit only.
{
  const list = document.getElementById('levelList');
  LEVELS.forEach((def, i) => {
    const btn = document.createElement('button');
    btn.className = 'lvl';
    btn.innerHTML = `<div class="n">MISSION ${String(i+1).padStart(2,'0')}</div>` +
                    `<div>${def.name}</div><div class="d">${def.blurb}</div>`;
    btn.addEventListener('pointerdown', ev => {
      ev.stopPropagation();
      menuEl.classList.add('off');
      loadLevel(def);
    });
    list.appendChild(btn);
  });
}

loadLevel(LEVELS[0]);   // build a world immediately so the menu has a backdrop
openMenu();

// ═══════════════════════════════════════════════════
// PLAYER UPDATE
// ═══════════════════════════════════════════════════
function updatePlayer(dt, t) {
  if (state !== S.FLYING && state !== S.READY) return;

  if (state === S.FLYING) {
    // steer: joystick deflection = desired velocity.
    // Screen x maps to world x; screen y maps to world z (screen up
    // = -Z = up the map, matching the top-down camera orientation).
    const wx = joy.x * CFG.player.maxSpeed;
    const wz = joy.y * CFG.player.maxSpeed;
    player.vel.x = lerp(player.vel.x, wx, CFG.player.accel*dt);
    player.vel.z = lerp(player.vel.z, wz, CFG.player.accel*dt);
    player.pos.x += player.vel.x*dt;
    player.pos.z += player.vel.z*dt;
    const w = worldBounds;
    player.pos.x = clamp(player.pos.x, w.minX, w.maxX);
    player.pos.z = clamp(player.pos.z, w.minZ, w.maxZ);

    // obstacle clip = explode right there
    if (circleHitsAnyObstacle(player.pos.x, player.pos.z, CFG.player.radius)) {
      detonate('COLLISION');
      return;
    }

    // ramming the target also detonates — and since you're touching it,
    // it's inside your blast radius: ramming is a legitimate kill
    if (enemy.alive &&
        Math.hypot(player.pos.x-enemy.pos.x, player.pos.z-enemy.pos.z)
          < CFG.player.radius + CFG.enemy.bodyRadius) {
      detonate('DIRECT HIT');
      return;
    }
    // intercept: flying directly under the Shahed counts as a ram
    if (shahed.alive &&
        Math.hypot(player.pos.x-shahed.pos.x, player.pos.z-shahed.pos.z)
          < CFG.player.radius + CFG.shahed.bodyRadius) {
      detonate('DIRECT HIT');
      return;
    }

    // thrust trail
    if (Math.hypot(player.vel.x, player.vel.z) > 4) {
      trailPool.spawn(
        player.pos.x+(Math.random()-.5), CFG.player.hoverY-0.4, player.pos.z+(Math.random()-.5),
        -player.vel.x*0.15, -1-Math.random()*2, -player.vel.z*0.15,
        0.4, 0.1, 0.9, 0.4, PHYS.THRUST);
    }
  }

  // rotate to face movement direction (with angle wrapping so the
  // drone turns the short way around), lean forward with speed
  const speed = Math.hypot(player.vel.x, player.vel.z);
  if (speed > 2) {
    const targetYaw = Math.atan2(player.vel.x, player.vel.z);
    let dyaw = targetYaw - player.yaw;
    while (dyaw >  Math.PI) dyaw -= Math.PI*2;
    while (dyaw < -Math.PI) dyaw += Math.PI*2;
    player.yaw += dyaw * Math.min(8*dt, 1);
  }
  player.group.rotation.y = player.yaw;
  player.group.rotation.x = lerp(player.group.rotation.x, -speed*0.008, 0.1); // nose-down lean

  // hover bob
  player.pos.y = CFG.player.hoverY + Math.sin(t*3)*0.12;
  player.group.position.copy(player.pos);
  for (const prop of player.props) prop.rotation.y += 40*dt;
}

// ═══════════════════════════════════════════════════
// MAIN LOOP — rdt is real time (camera, cinematics, UI);
// sdt = rdt * timeScale is simulation time (physics, AI, bullets).
// Slow motion = shrinking sdt while rdt keeps flowing.
// ═══════════════════════════════════════════════════
let lastNow = performance.now();

function animate() {
  requestAnimationFrame(animate);
  const now = performance.now();
  const rdt = Math.min((now-lastNow)*0.001, 0.05);
  lastNow = now;
  const sdt = rdt * timeScale;
  const t = now*0.001;

  if (flashCd > 0) { flashCd -= rdt; if (flashCd <= 0) flashEl.classList.remove('on'); }

  if (state === S.BOOM) updateBoom(rdt);
  if (state === S.FAIL) { failTimer -= rdt; if (failTimer <= 0) resetLevel(); }

  updatePlayer(sdt, t);
  M.update(sdt, t);
  updateBullets(sdt);
  // pools take both clocks: sdt drives physics, rdt drives the hold
  burstPool.update(sdt, rdt);
  sparkPool.update(sdt, rdt);
  trailPool.update(sdt, rdt);
  smokePool.update(sdt, rdt);
  shardPool.update(sdt, rdt);
  updateShockwaves(sdt);
  updateCamera(rdt);
  updateHUD();

  renderer.render(scene, camera);
  drawOverlay();
}
animate();

window.addEventListener('resize', () => {
  camera.aspect = innerWidth/innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  resizeOverlay();
});

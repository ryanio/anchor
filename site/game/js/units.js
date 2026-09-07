/**
 * Units are formations, not men. Every order, every casualty and every morale check happens at the
 * level of the block; the forty soldiers inside it are chasing slots in a grid and are only ever
 * there to make the block legible. One InstancedMesh per unit draws all of them.
 */
(function (A) {
  "use strict";

  /**
   * Three roles, one triangle: swords beat spears in a brawl, spears beat horse, horse rides down
   * swords. The numbers are deliberately loud — a rock-paper-scissors you cannot feel is decoration.
   */
  A.TYPES = {
    sword: {
      men: 40, cols: 10, fileGap: 1.05, rankGap: 1.20,
      speed: 3.6, turn: 1.5, attack: 1.00, defense: 1.00,
      charge: 1.8, chargeDur: 3.0, steadiness: 2, reach: 1.5,
    },
    spear: {
      men: 40, cols: 10, fileGap: 1.12, rankGap: 1.32,
      speed: 3.1, turn: 1.1, attack: 0.85, defense: 1.22,
      charge: 1.3, chargeDur: 2.5, steadiness: 16, reach: 1.9,
    },
    cavalry: {
      men: 24, cols: 8, fileGap: 1.80, rankGap: 2.25,
      speed: 8.4, turn: 2.0, attack: 1.35, defense: 0.85,
      charge: 3.6, chargeDur: 3.5, steadiness: 6, reach: 1.7,
    },
  };

  A.MATCHUP = {
    sword:   { sword: 1.00, spear: 1.35, cavalry: 0.85 },
    spear:   { sword: 0.80, spear: 1.00, cavalry: 2.10 },
    cavalry: { sword: 1.30, spear: 0.55, cavalry: 1.00 },
  };

  // Scratch objects, built on first use: these files are classic scripts and run before the inline
  // module has had a chance to publish THREE.
  let _m, _q, _p, _s, UP;
  function scratch() {
    if (_m) return;
    _m = new THREE.Matrix4();
    _q = new THREE.Quaternion();
    _p = new THREE.Vector3();
    _s = new THREE.Vector3();
    UP = new THREE.Vector3(0, 1, 0);
  }

  let nextId = 1;

  A.Unit = class Unit {
    constructor(game, spec) {
      scratch();
      const def = A.TYPES[spec.type];
      this.game = game;
      this.id = nextId++;
      this.side = spec.side;
      this.type = spec.type;
      this.name = spec.name;
      this.def = def;
      this.livery = spec.livery;

      this.initial = def.men;
      this.alive = def.men;
      this.morale = 100;
      this.state = "idle";
      this.killAccum = 0;
      this.lossTimes = [];
      this.chargeTimer = 0;
      this.routTimer = 0;
      this.selected = false;

      // Per-frame combat readings, refilled by combat.js.
      this.contactsOn = 0;      // my men touching an enemy
      this.contactsAgainst = 0; // enemy men touching me
      this.frontShare = 1;      // fraction of incoming contact landing on my front arc
      this.worstFlank = 0;      // 0 front, 1.2 flank, 2.5 rear — the largest coming at me
      this.attackers = new Set();
      this.threatX = 0;
      this.threatZ = 0;

      this.pos = { x: spec.x, z: spec.z };
      this.facing = spec.facing;
      this.speedNow = 0;
      this.order = { x: spec.x, z: spec.z, facing: spec.facing, hasFacing: true };

      this.rows = Math.ceil(def.men / def.cols);
      this.halfWidth = (def.cols * def.fileGap) / 2;
      this.halfDepth = (this.rows * def.rankGap) / 2;
      this.radius = Math.hypot(this.halfWidth, this.halfDepth);

      this.buildSoldiers(game.rng);
      this.buildMeshes(game);
    }

    buildSoldiers(rng) {
      const d = this.def;
      this.soldiers = [];
      for (let i = 0; i < d.men; i++) {
        const c = i % d.cols;
        const r = Math.floor(i / d.cols);
        const ox = (c - (d.cols - 1) / 2) * d.fileGap;
        const oz = ((this.rows - 1) / 2 - r) * d.rankGap;
        const x = this.pos.x + ox * Math.cos(this.facing) + oz * Math.sin(this.facing);
        const z = this.pos.z - ox * Math.sin(this.facing) + oz * Math.cos(this.facing);
        this.soldiers.push({
          ox, oz, rank: r, x, z, y: 0,
          alive: true,
          phase: rng.range(0, Math.PI * 2),
          // A little permanent slop per man so ranks are never machine-straight.
          wx: rng.gauss() * 0.14, wz: rng.gauss() * 0.14,
          scale: rng.range(0.93, 1.07),
          pushX: 0, pushZ: 0,
          face: this.facing,
          faceWant: this.facing,
          fighting: false,
        });
      }
    }

    buildMeshes(game) {
      const geo = A.soldierGeometry(this.type, this.livery, this.tunicColor(), this.coatColor());
      this.mesh = new THREE.InstancedMesh(geo, game.soldierMaterial, this.initial);
      this.mesh.frustumCulled = false;
      this.mesh.userData.unit = this;
      game.scene.add(this.mesh);

      this.banner = new THREE.Mesh(A.bannerGeometry(this.livery), game.soldierMaterial);
      this.banner.frustumCulled = false;
      game.scene.add(this.banner);

      // Ground shade: the single cheapest thing that makes a grid of men read as one block.
      const shadeSize = Math.max(this.halfWidth, this.halfDepth) * 2.9;
      this.shade = new THREE.Mesh(
        new THREE.PlaneGeometry(shadeSize, shadeSize),
        new THREE.MeshBasicMaterial({
          map: game.blob, color: 0x141a0e, transparent: true,
          opacity: 0.42, depthWrite: false,
        }),
      );
      this.shade.rotation.x = -Math.PI / 2;
      this.shade.renderOrder = 1;
      game.scene.add(this.shade);

      this.outline = this.buildOutline(game);
      game.scene.add(this.outline);
    }

    /** A rectangle of four thin slabs, drawn on top of everything so hills never hide it. */
    buildOutline(game) {
      const g = new THREE.Group();
      const w = this.halfWidth + 0.9;
      const d = this.halfDepth + 0.9;
      const mat = new THREE.MeshBasicMaterial({
        color: 0xe0b566, depthTest: false, transparent: true, opacity: 0.95,
      });
      const bar = (sx, sz, x, z) => {
        const m = new THREE.Mesh(new THREE.BoxGeometry(sx, 0.06, sz), mat);
        m.position.set(x, 0, z);
        m.renderOrder = 20;
        return m;
      };
      g.add(bar(w * 2, 0.26, 0, d), bar(w * 2, 0.26, 0, -d));
      g.add(bar(0.26, d * 2, w, 0), bar(0.26, d * 2, -w, 0));
      g.visible = false;
      return g;
    }

    /** Deliberately duller than the livery: the shield carries the army colour, the tunic the man. */
    tunicColor() {
      if (this.side === 0) return this.type === "spear" ? 0x8d4a30 : 0xa5573a;
      return this.type === "spear" ? 0x2f5c80 : 0x39705c;
    }
    coatColor() { return this.side === 0 ? 0x5a4230 : 0x3a3129; }

    // ── orders ─────────────────────────────────────────────────────────────
    orderMove(x, z, facing) {
      if (this.state === "routing" || this.state === "gone") return;
      this.order.x = this.game.terrain.clampX(x);
      this.order.z = this.game.terrain.clampZ(z);
      this.order.hasFacing = facing !== undefined && facing !== null;
      this.order.facing = this.order.hasFacing ? facing : this.facing;
    }

    holdHere() { this.orderMove(this.pos.x, this.pos.z, this.facing); }

    // ── per-frame ──────────────────────────────────────────────────────────
    update(dt, now) {
      if (this.state === "gone") return;
      if (this.state === "routing") this.updateRout(dt, now);
      else this.updateOrdered(dt);

      this.chargeTimer = Math.max(0, this.chargeTimer - dt);
      this.updateSoldiers(dt, now);
      this.updateMeshes(now);
    }

    updateOrdered(dt) {
      const engaged = this.contactsOn > 0 || this.contactsAgainst > 0;
      const dx = this.order.x - this.pos.x;
      const dz = this.order.z - this.pos.z;
      const dist = Math.hypot(dx, dz);

      let desired = this.facing;
      if (engaged) {
        // A formation in contact wheels to face what is hitting it — but slowly, and only if its
        // front is not already busy. That four-second window is what makes a flank worth doing,
        // and why pinning the enemy first is the whole trick.
        if (this.frontShare < 0.35 && this.contactsAgainst > 0) {
          const tx = this.threatX - this.pos.x;
          const tz = this.threatZ - this.pos.z;
          if (Math.hypot(tx, tz) > 0.5) desired = Math.atan2(tx, tz);
          const turn = 0.30 * dt;
          this.facing += A.clamp(A.angleDelta(this.facing, desired), -turn, turn);
        }
        this.speedNow = 0;
        this.state = "fighting";
        return;
      }

      if (dist > 0.6) {
        desired = Math.atan2(dx, dz);
      } else if (this.order.hasFacing) {
        desired = this.order.facing;
      }
      const turn = this.def.turn * dt;
      this.facing += A.clamp(A.angleDelta(this.facing, desired), -turn, turn);

      if (dist > 0.6) {
        // Blocks pivot before they march; wheeling at full speed would look like a flock, not a line.
        const align = Math.max(0.22, Math.cos(A.angleDelta(this.facing, Math.atan2(dx, dz))));
        const step = Math.min(dist, this.def.speed * align * dt);
        this.pos.x += (dx / dist) * step;
        this.pos.z += (dz / dist) * step;
        this.speedNow = step / dt;
        this.state = "moving";
      } else {
        this.speedNow = 0;
        this.state = "idle";
      }
    }

    updateRout(dt, now) {
      this.routTimer += dt;
      const t = this.game.terrain;
      const homeZ = this.side === 0 ? -t.depth / 2 - 45 : t.depth / 2 + 45;
      const dx = this.pos.x * 0.35 - this.pos.x;
      const dz = homeZ - this.pos.z;
      const dist = Math.hypot(dx, dz) || 1;
      const speed = this.def.speed * 1.35;
      this.pos.x += (dx / dist) * speed * dt;
      this.pos.z += (dz / dist) * speed * dt;
      this.speedNow = speed;
      const desired = Math.atan2(dx, dz);
      const turn = this.def.turn * 1.8 * dt;
      this.facing += A.clamp(A.angleDelta(this.facing, desired), -turn, turn);
      if (Math.abs(this.pos.z) > t.depth / 2 + 34 || this.routTimer > 40) this.vanish();
    }

    updateSoldiers(dt, now) {
      const cf = Math.cos(this.facing);
      const sf = Math.sin(this.facing);
      const routing = this.state === "routing";
      // Routers stop being a formation: the grid blows apart and that is the visual tell.
      const spread = routing ? 2.4 : 1;
      const chase = this.def.speed * (routing ? 2.0 : 1.75);
      const terrain = this.game.terrain;

      for (const s of this.soldiers) {
        if (!s.alive) continue;
        const ox = s.ox * spread;
        const oz = s.oz * spread;
        let tx = this.pos.x + ox * cf + oz * sf + s.wx + s.pushX;
        let tz = this.pos.z - ox * sf + oz * cf + s.wz + s.pushZ;
        if (routing) {
          tx += Math.sin(now * 1.7 + s.phase) * 1.4;
          tz += Math.cos(now * 1.3 + s.phase * 1.7) * 1.4;
        }
        const dx = tx - s.x;
        const dz = tz - s.z;
        const d = Math.hypot(dx, dz);
        if (d > 0.01) {
          const step = Math.min(d, chase * dt);
          s.x += (dx / d) * step;
          s.z += (dz / d) * step;
          s.moving = d > 0.25;
        } else {
          s.moving = false;
        }
        s.ground = terrain.heightAt(s.x, s.z);

        const want = s.fighting ? s.faceWant : this.facing;
        const turn = 6 * dt;
        s.face += A.clamp(A.angleDelta(s.face, want), -turn, turn);
      }
    }

    updateMeshes(now) {
      const mesh = this.mesh;
      const cav = this.type === "cavalry";
      const bobRate = cav ? 11 : 7.5;
      const bobAmp = cav ? 0.15 : 0.075;
      for (let i = 0; i < this.soldiers.length; i++) {
        const s = this.soldiers[i];
        if (!s.alive) {
          _p.set(0, -900, 0);
          _s.set(0.0001, 0.0001, 0.0001);
          _q.identity();
          mesh.setMatrixAt(i, _m.compose(_p, _q, _s));
          continue;
        }
        let y = s.ground;
        let lean = 0;
        if (s.moving) y += Math.abs(Math.sin(now * bobRate + s.phase)) * bobAmp;
        if (s.fighting) {
          // A short lunge in and out: at this zoom that shimmer is what "melee" looks like.
          lean = Math.sin(now * 5.5 + s.phase) * 0.16;
          y += Math.abs(Math.sin(now * 5.5 + s.phase)) * 0.03;
        }
        _p.set(s.x + Math.sin(s.face) * lean, y, s.z + Math.cos(s.face) * lean);
        _q.setFromAxisAngle(UP, s.face);
        _s.set(s.scale, s.scale, s.scale);
        mesh.setMatrixAt(i, _m.compose(_p, _q, _s));
      }
      mesh.instanceMatrix.needsUpdate = true;

      const gy = this.game.terrain.heightAt(this.pos.x, this.pos.z);
      this.banner.position.set(this.pos.x, gy, this.pos.z);
      this.banner.rotation.y = this.facing + Math.sin(now * 1.4 + this.id) * 0.09;
      this.banner.rotation.z = Math.sin(now * 0.9 + this.id) * 0.035 +
        (this.state === "routing" ? 0.5 : 0);

      this.shade.position.set(this.pos.x, gy + 0.06, this.pos.z);
      this.shade.material.opacity = this.state === "routing" ? 0.16 : 0.42;

      this.outline.visible = this.selected && this.state !== "gone";
      if (this.outline.visible) {
        this.outline.position.set(this.pos.x, gy + 0.5, this.pos.z);
        this.outline.rotation.y = this.facing;
      }
    }

    // ── casualties and morale ──────────────────────────────────────────────
    /** Kill the man nearest whoever is doing the killing, so the line thins where it is pressed. */
    killNearest(fromX, fromZ, now) {
      let best = null;
      let bestD = Infinity;
      for (const s of this.soldiers) {
        if (!s.alive) continue;
        const d = (s.x - fromX) ** 2 + (s.z - fromZ) ** 2;
        if (d < bestD) { bestD = d; best = s; }
      }
      if (!best) return;
      best.alive = false;
      this.alive--;
      this.lossTimes.push(now);
      this.game.addCorpse(this.side, best.x, best.z, best.face);
      if (this.alive <= 0) this.vanish();
    }

    recentLosses(now) {
      while (this.lossTimes.length && now - this.lossTimes[0] > 3) this.lossTimes.shift();
      return this.lossTimes.length;
    }

    vanish() {
      this.state = "gone";
      this.mesh.visible = false;
      this.banner.visible = false;
      this.shade.visible = false;
      this.outline.visible = false;
      this.selected = false;
    }

    get lossFraction() { return 1 - this.alive / this.initial; }
    get isActive() { return this.state !== "gone" && this.state !== "routing"; }
    get displayState() {
      if (this.state === "routing") return "routing";
      if (this.state === "fighting") return "in melee";
      if (this.state === "moving") return "advancing";
      return "holding";
    }
  };
})((window.Anchor = window.Anchor || {}));

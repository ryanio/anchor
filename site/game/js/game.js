/**
 * Battle for the Ford — one engagement, two armies, no campaign map.
 *
 * The scenario is stacked on purpose: Rome fields fewer men in the line but twice the cavalry, so
 * winning means pinning the Gallic warbands with the hastati and then taking them in the back with
 * the equites. Fight it as a shoving match and you lose on numbers.
 *
 * URL parameters, mostly for taking honest screenshots of a battle in progress:
 *   ?seed=123   pick the battlefield and the dice
 *   ?t=45       fast-forward the simulation this many seconds before the first frame
 *   ?auto=1     let the AI command Rome as well, so the battle plays itself
 */
(function (A) {
  "use strict";

  const ROSTER = [
    // Rome deploys the classic three lines squeezed into one: hastati across the front, the
    // triarii held back as a reserve, and the horse out on both wings where it belongs.
    { side: 0, type: "sword",   name: "Hastati I",    x: -13, z: -34 },
    { side: 0, type: "sword",   name: "Hastati II",   x:   0, z: -34 },
    { side: 0, type: "sword",   name: "Principes",    x:  13, z: -34 },
    { side: 0, type: "spear",   name: "Triarii",      x:   0, z: -48 },
    { side: 0, type: "cavalry", name: "Equites I",    x: -32, z: -29 },
    { side: 0, type: "cavalry", name: "Equites II",   x:  32, z: -29 },

    // The Gauls have a wider line and more of it, which is the problem the player has to solve.
    { side: 1, type: "sword",   name: "Warband I",    x: -19, z:  34 },
    { side: 1, type: "sword",   name: "Warband II",   x:  -6, z:  34 },
    { side: 1, type: "sword",   name: "Warband III",  x:   7, z:  34 },
    { side: 1, type: "sword",   name: "Warband IV",   x:  20, z:  34 },
    { side: 1, type: "spear",   name: "Gaesatae",     x:   0, z:  47 },
    { side: 1, type: "cavalry", name: "Gallic Horse", x: -40, z:  29 },
  ];

  const LIVERY = [0xc0392b, 0x3a6ea5];

  /** Distance from a formation's centre to its edge in a given world direction. */
  function rectRadius(u, dx, dz) {
    const cf = Math.cos(u.facing);
    const sf = Math.sin(u.facing);
    const lx = Math.abs(dx * cf - dz * sf) / u.halfWidth;
    const lz = Math.abs(dx * sf + dz * cf) / u.halfDepth;
    return 1 / Math.max(lx, lz, 1e-6);
  }

  A.fatal = function (msg) {
    const boot = document.getElementById("boot");
    if (!boot) return;
    boot.hidden = false;
    boot.className = "fatal";
    boot.textContent = "The battle would not start: " + msg;
  };

  A.Game = class Game {
    constructor() {
      const params = new URLSearchParams(location.search);
      this.params = params;
      this.autoPlay = params.get("auto") === "1";
      this.seed = Number(params.get("seed")) || 20260907;

      this.renderer = new THREE.WebGLRenderer({
        canvas: document.getElementById("stage"),
        antialias: true,
      });
      this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
      this.camera = new THREE.PerspectiveCamera(46, 1, 0.5, 900);
      this.blob = A.blobTexture();
      this.soldierMaterial = new THREE.MeshLambertMaterial({ vertexColors: true });

      this.hud = new A.Hud(this);
      this.paused = false;
      this.time = 0;
      this.over = false;

      this.resize();
      addEventListener("resize", () => this.resize());

      this.build();
      this.controls = new A.Controls(this);

      const skip = Number(params.get("t")) || 0;
      if (skip > 0) this.fastForward(skip);

      this.last = performance.now();
      this.loop = this.loop.bind(this);
      requestAnimationFrame(this.loop);
    }

    // ── scene ──────────────────────────────────────────────────────────────
    build() {
      this.rng = A.makeRng(this.seed);
      this.scene = new THREE.Scene();
      this.scene.fog = new THREE.Fog(0xc9c9b6, 290, 760);

      this.scene.add(this.sky());
      // A low, raking sun: gentle hills only read as hills if something is shading their far side.
      const hemi = new THREE.HemisphereLight(0xbcd4e8, 0x4b5326, 1.05);
      this.scene.add(hemi);
      const sun = new THREE.DirectionalLight(0xffeecb, 2.6);
      sun.position.set(-120, 62, 48);
      this.scene.add(sun);

      this.terrain = new A.Terrain(this.rng);
      this.terrain.build(this.scene, this.rng);

      this.units = ROSTER.map((spec) =>
        new A.Unit(this, {
          side: spec.side,
          type: spec.type,
          name: spec.name,
          livery: LIVERY[spec.side],
          x: spec.x,
          z: spec.z,
          facing: spec.side === 0 ? 0 : Math.PI,
        }));

      this.startingMen = [0, 0];
      for (const u of this.units) this.startingMen[u.side] += u.initial;

      this.buildCorpses();
      this.buildPings();
      this.selected = [];
      this.over = false;
      this.time = 0;
      this.resultAt = 0;
    }

    /** A gradient dome. Cheaper and calmer than a skybox, and it sets the whole colour key. */
    sky() {
      const g = new THREE.SphereGeometry(620, 20, 14);
      const pos = g.attributes.position;
      const col = new Float32Array(pos.count * 3);
      const low = new THREE.Color(0xdcd0b0);
      const high = new THREE.Color(0x5d86b3);
      const c = new THREE.Color();
      for (let i = 0; i < pos.count; i++) {
        c.copy(low).lerp(high, A.clamp(pos.getY(i) / 380 + 0.08, 0, 1));
        col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
      }
      g.setAttribute("color", new THREE.BufferAttribute(col, 3));
      const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
        vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false,
      }));
      m.renderOrder = -1;
      return m;
    }

    buildCorpses() {
      this.corpses = [0, 1].map((side) => {
        const mesh = new THREE.InstancedMesh(
          A.corpseGeometry(LIVERY[side]), this.soldierMaterial, this.startingMen[side],
        );
        mesh.count = 0;
        mesh.frustumCulled = false;
        this.scene.add(mesh);
        return mesh;
      });
      this._cm = new THREE.Matrix4();
      this._cq = new THREE.Quaternion();
      this._cp = new THREE.Vector3();
      this._cs = new THREE.Vector3(1, 1, 1);
      this._up = new THREE.Vector3(0, 1, 0);
    }

    /** The dead stay on the field. Where the line stood is written in bodies by the end. */
    addCorpse(side, x, z, face) {
      const mesh = this.corpses[side];
      if (mesh.count >= mesh.instanceMatrix.count) return;
      this._cp.set(x, this.terrain.heightAt(x, z) + 0.02, z);
      this._cq.setFromAxisAngle(this._up, face + this.rng.range(-0.7, 0.7));
      mesh.setMatrixAt(mesh.count, this._cm.compose(this._cp, this._cq, this._cs));
      mesh.count++;
      mesh.instanceMatrix.needsUpdate = true;
    }

    buildPings() {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xe0b566, transparent: true, opacity: 0, depthTest: false,
      });
      this.pings = [];
      for (let i = 0; i < 8; i++) {
        const m = new THREE.Mesh(new THREE.RingGeometry(0.72, 1, 24), mat.clone());
        m.rotation.x = -Math.PI / 2;
        m.renderOrder = 22;
        m.visible = false;
        this.scene.add(m);
        this.pings.push({ mesh: m, life: 0 });
      }
    }

    ping(x, z) {
      const p = this.pings.find((q) => q.life <= 0) || this.pings[0];
      p.life = 0.85;
      p.mesh.visible = true;
      p.mesh.position.set(x, this.terrain.heightAt(x, z) + 0.3, z);
    }

    updatePings(dt) {
      for (const p of this.pings) {
        if (p.life <= 0) continue;
        p.life -= dt;
        const k = Math.max(0, p.life) / 0.85;
        const s = A.lerp(4.2, 1.1, k);
        p.mesh.scale.set(s, s, s);
        p.mesh.material.opacity = k * 0.9;
        if (p.life <= 0) p.mesh.visible = false;
      }
    }

    // ── selection and orders ───────────────────────────────────────────────
    select(units) {
      const set = new Set(units.filter((u) => u && u.state !== "gone"));
      for (const u of this.units) u.selected = set.has(u);
      this.selected = [...set];
    }

    selectAll() {
      this.select(this.units.filter((u) => u.side === 0 && u.isActive));
    }

    /** Lay the selected units out as one line, in the order they already stand, and march them. */
    issueOrders(x, z, facing) {
      const sel = this.selected.filter((u) => u.state !== "gone" && u.state !== "routing");
      if (!sel.length) return;
      let f = facing;
      if (f === null || f === undefined) {
        const cx = sel.reduce((s, u) => s + u.pos.x, 0) / sel.length;
        const cz = sel.reduce((s, u) => s + u.pos.z, 0) / sel.length;
        f = Math.atan2(x - cx, z - cz);
      }
      const rx = Math.cos(f);
      const rz = -Math.sin(f);
      sel.sort((a, b) => (a.pos.x * rx + a.pos.z * rz) - (b.pos.x * rx + b.pos.z * rz));
      const gap = 2.8;
      const total = sel.reduce((s, u) => s + u.halfWidth * 2, 0) + gap * (sel.length - 1);
      let cursor = -total / 2;
      for (const u of sel) {
        cursor += u.halfWidth;
        u.orderMove(x + rx * cursor, z + rz * cursor, f);
        cursor += u.halfWidth + gap;
      }
      this.ping(x, z);
    }

    togglePause() {
      this.paused = !this.paused;
      this.hud.toast(this.paused ? "Paused" : "Resumed", this.time);
    }

    onRout(u) {
      this.hud.toast(
        u.side === 0 ? u.name + " has broken and is fleeing!" : u.name + " breaks and runs!",
        this.time,
      );
    }

    // ── simulation ─────────────────────────────────────────────────────────
    step(dt) {
      this.time += dt;
      if (!this.over) {
        A.AI.update(this, 1, this.time);
        if (this.autoPlay) A.AI.update(this, 0, this.time);
      }
      for (const u of this.units) u.update(dt, this.time);
      this.separate(dt);
      A.Combat.resolve(this, dt, this.time);
      this.selected = this.selected.filter((u) => u.state !== "gone");
      this.checkVictory();
    }

    /**
     * Formations are solid. Without this two blocks walk straight through each other and a battle
     * turns into one interpenetrating mob — which was exactly what the first playable build looked
     * like. Rectangles, not circles: a ten-wide line is nothing like a disc.
     */
    separate(dt) {
      const us = this.units.filter((u) => u.state !== "gone" && u.state !== "routing");
      const k = Math.min(1, 9 * dt) * 0.5;
      for (let i = 0; i < us.length; i++) {
        for (let j = i + 1; j < us.length; j++) {
          const a = us[i];
          const b = us[j];
          let dx = b.pos.x - a.pos.x;
          let dz = b.pos.z - a.pos.z;
          let d = Math.hypot(dx, dz);
          if (d < 0.01) { dx = 0.01; dz = 0; d = 0.01; }
          const nx = dx / d;
          const nz = dz / d;
          // Overlap is allowed to be slightly negative so front ranks still reach each other.
          const minD = rectRadius(a, nx, nz) + rectRadius(b, -nx, -nz) - 1.0;
          if (d >= minD) continue;
          const push = (minD - d) * (a.side === b.side ? 0.5 : 0.95) * k;
          a.pos.x -= nx * push; a.pos.z -= nz * push;
          b.pos.x += nx * push; b.pos.z += nz * push;
        }
      }
    }

    checkVictory() {
      if (this.over) return;
      const left = [0, 1].map((s) => this.units.filter((u) => u.side === s && u.isActive).length);
      if (left[0] > 0 && left[1] > 0) return;
      this.over = true;
      const won = left[0] > 0;
      const survivors = this.units
        .filter((u) => u.side === 0 && u.isActive)
        .reduce((n, u) => n + u.alive, 0);
      this.hud.showResult(
        won,
        won
          ? "The Gauls are broken. " + survivors + " of " + this.startingMen[0] +
            " Romans still stand in formation."
          : "Rome's line has given way. What is left of the legion is running for the trees.",
      );
    }

    /** Run the battle forward without drawing it — used by ?t= for reproducible screenshots. */
    fastForward(seconds) {
      const dt = 1 / 30;
      for (let i = 0; i < Math.min(seconds, 300) * 30; i++) {
        this.step(dt);
        this.controls.update(dt); // so the camera arrives already looking at the fighting
      }
    }

    restart() {
      for (const u of this.units) {
        u.mesh.dispose();
        u.outline.traverse((o) => o.geometry && o.geometry.dispose());
      }
      this.terrain.mesh.geometry.dispose();
      this.terrain.trees.dispose();
      this.terrain.trees.geometry.dispose();
      this.hud.reset();
      this.seed = (this.seed * 1103515245 + 12345) >>> 0;
      this.build();
      this.hud.toast("A new field, a new battle.", 0);
    }

    // ── frame ──────────────────────────────────────────────────────────────
    resize() {
      const w = innerWidth;
      const h = innerHeight;
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }

    loop(nowMs) {
      requestAnimationFrame(this.loop);
      const dt = Math.min(0.05, (nowMs - this.last) / 1000);
      this.last = nowMs;
      this.controls.update(dt);
      if (!this.paused) this.step(dt);
      this.updatePings(dt);
      this.hud.update(this.time);
      this.renderer.render(this.scene, this.camera);
      const boot = document.getElementById("boot");
      if (boot && !boot.hidden && !boot.classList.contains("fatal")) boot.hidden = true;
    }
  };

  A.boot = function () {
    try {
      const game = new A.Game();
      A.game = game;
      // The help panel sits over the right wing. Let it get out of the way.
      const help = document.getElementById("help");
      help.title = "click to collapse";
      help.addEventListener("click", () => help.classList.toggle("collapsed"));
      if (!game.params.get("t")) {
        game.hud.toast("Pin them with the hastati, then take them in the back.", 0);
      }
    } catch (err) {
      A.fatal(err && err.message ? err.message : String(err));
      throw err;
    }
  };
})((window.Anchor = window.Anchor || {}));

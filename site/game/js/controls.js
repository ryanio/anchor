/**
 * Camera and orders. RTS conventions, because they are the ones the hands already know: left-click
 * and drag to select, right-click to order, WASD and the screen edge to pan, wheel to zoom.
 *
 * The one thing worth calling out is right-DRAG: press where you want the line to stand, drag in the
 * direction you want it to face, release. Facing is half the game, so it gets its own gesture rather
 * than being inferred from the walk.
 */
(function (A) {
  "use strict";

  const MIN_DIST = 26;
  const MAX_DIST = 170;
  const EDGE = 16;

  A.Controls = class Controls {
    constructor(game) {
      this.game = game;
      this.canvas = game.renderer.domElement;
      this.camera = game.camera;

      this.target = new THREE.Vector3(0, 0, -8);
      this.yaw = Math.PI;
      this.dist = 78;

      this.keys = new Set();
      this.mouse = { x: 0, y: 0, inside: false };
      this.drag = null;
      this.rightDrag = null;
      this.userMoved = false;

      this.raycaster = new THREE.Raycaster();
      this.ndc = new THREE.Vector2();
      this.marquee = document.getElementById("marquee");

      this.bind();
      this.apply();
    }

    bind() {
      const c = this.canvas;
      addEventListener("contextmenu", (e) => e.preventDefault());
      addEventListener("keydown", (e) => this.onKey(e, true));
      addEventListener("keyup", (e) => this.onKey(e, false));
      addEventListener("blur", () => this.keys.clear());
      addEventListener("pointermove", (e) => this.onMove(e));
      addEventListener("pointerleave", () => { this.mouse.inside = false; });
      c.addEventListener("pointerdown", (e) => this.onDown(e));
      addEventListener("pointerup", (e) => this.onUp(e));
      c.addEventListener("wheel", (e) => {
        e.preventDefault();
        this.dist = A.clamp(this.dist * Math.exp(e.deltaY * 0.0013), MIN_DIST, MAX_DIST);
        this.userMoved = true;
      }, { passive: false });
    }

    onKey(e, down) {
      const k = e.key.toLowerCase();
      if (down && k === " ") { e.preventDefault(); this.game.togglePause(); return; }
      if (down && k === "tab") { e.preventDefault(); this.game.selectAll(); return; }
      if (down && k === "escape") { this.game.select([]); return; }
      if (down && k === "r" && (e.ctrlKey || e.metaKey)) return;
      if (["w", "a", "s", "d", "q", "e", "arrowup", "arrowdown", "arrowleft", "arrowright"]
        .includes(k)) {
        e.preventDefault();
        if (down) this.keys.add(k); else this.keys.delete(k);
      }
    }

    onMove(e) {
      this.mouse.x = e.clientX;
      this.mouse.y = e.clientY;
      this.mouse.inside = true;
      if (this.drag) {
        this.drag.x2 = e.clientX;
        this.drag.y2 = e.clientY;
        if (Math.abs(this.drag.x2 - this.drag.x1) + Math.abs(this.drag.y2 - this.drag.y1) > 6) {
          this.drag.boxed = true;
          const m = this.marquee;
          m.hidden = false;
          m.style.left = Math.min(this.drag.x1, this.drag.x2) + "px";
          m.style.top = Math.min(this.drag.y1, this.drag.y2) + "px";
          m.style.width = Math.abs(this.drag.x2 - this.drag.x1) + "px";
          m.style.height = Math.abs(this.drag.y2 - this.drag.y1) + "px";
        }
      }
    }

    onDown(e) {
      if (e.button === 0) {
        this.drag = { x1: e.clientX, y1: e.clientY, x2: e.clientX, y2: e.clientY, boxed: false,
                      add: e.shiftKey };
      } else if (e.button === 2) {
        const p = this.groundPoint(e.clientX, e.clientY);
        if (p) this.rightDrag = { from: p, x: e.clientX, y: e.clientY };
      }
    }

    onUp(e) {
      if (e.button === 0 && this.drag) {
        const d = this.drag;
        this.drag = null;
        this.marquee.hidden = true;
        if (d.boxed) this.boxSelect(d);
        else this.clickSelect(e.clientX, e.clientY, d.add);
      } else if (e.button === 2 && this.rightDrag) {
        const from = this.rightDrag.from;
        this.rightDrag = null;
        const to = this.groundPoint(e.clientX, e.clientY) || from;
        const dx = to.x - from.x;
        const dz = to.z - from.z;
        const facing = Math.hypot(dx, dz) > 4 ? Math.atan2(dx, dz) : null;
        this.game.issueOrders(from.x, from.z, facing);
      }
    }

    groundPoint(px, py) {
      const r = this.canvas.getBoundingClientRect();
      this.ndc.set(((px - r.left) / r.width) * 2 - 1, -((py - r.top) / r.height) * 2 + 1);
      this.raycaster.setFromCamera(this.ndc, this.camera);
      const hit = this.raycaster.intersectObject(this.game.terrain.mesh, false)[0];
      return hit ? { x: hit.point.x, z: hit.point.z } : null;
    }

    clickSelect(px, py, add) {
      const p = this.groundPoint(px, py);
      if (!p) return;
      let best = null;
      let bestD = Infinity;
      for (const u of this.game.units) {
        if (u.side !== 0 || u.state === "gone") continue;
        const rx = p.x - u.pos.x;
        const rz = p.z - u.pos.z;
        const cf = Math.cos(u.facing);
        const sf = Math.sin(u.facing);
        const lx = rx * cf - rz * sf;
        const lz = rx * sf + rz * cf;
        const over = Math.abs(lx) < u.halfWidth + 2 && Math.abs(lz) < u.halfDepth + 2;
        const d = rx * rx + rz * rz;
        if (over && d < bestD) { bestD = d; best = u; }
      }
      if (!best) { if (!add) this.game.select([]); return; }
      this.game.select(add ? this.game.selected.concat([best]) : [best]);
    }

    boxSelect(d) {
      const x1 = Math.min(d.x1, d.x2);
      const x2 = Math.max(d.x1, d.x2);
      const y1 = Math.min(d.y1, d.y2);
      const y2 = Math.max(d.y1, d.y2);
      const r = this.canvas.getBoundingClientRect();
      const v = new THREE.Vector3();
      const picked = [];
      for (const u of this.game.units) {
        if (u.side !== 0 || u.state === "gone") continue;
        v.set(u.pos.x, this.game.terrain.heightAt(u.pos.x, u.pos.z) + 1, u.pos.z);
        v.project(this.camera);
        const sx = r.left + ((v.x + 1) / 2) * r.width;
        const sy = r.top + ((1 - v.y) / 2) * r.height;
        if (v.z < 1 && sx >= x1 && sx <= x2 && sy >= y1 && sy <= y2) picked.push(u);
      }
      this.game.select(d.add ? this.game.selected.concat(picked) : picked);
    }

    update(dt) {
      const k = this.keys;
      const fx = -Math.sin(this.yaw);
      const fz = -Math.cos(this.yaw);
      const rx = -fz;
      const rz = fx;
      let mx = 0;
      let mz = 0;
      if (k.has("w") || k.has("arrowup")) { mx += fx; mz += fz; }
      if (k.has("s") || k.has("arrowdown")) { mx -= fx; mz -= fz; }
      if (k.has("d") || k.has("arrowright")) { mx += rx; mz += rz; }
      if (k.has("a") || k.has("arrowleft")) { mx -= rx; mz -= rz; }

      // Edge scrolling, but never while a selection box is being dragged out.
      if (this.mouse.inside && !this.drag) {
        if (this.mouse.x < EDGE) { mx -= rx; mz -= rz; }
        else if (this.mouse.x > innerWidth - EDGE) { mx += rx; mz += rz; }
        if (this.mouse.y < EDGE) { mx += fx; mz += fz; }
        else if (this.mouse.y > innerHeight - EDGE) { mx -= fx; mz -= fz; }
      }

      const m = Math.hypot(mx, mz);
      if (m > 0 || k.has("q") || k.has("e")) this.userMoved = true;
      if (m > 0) {
        const speed = (24 + this.dist * 0.42) * dt;
        this.target.x += (mx / m) * speed;
        this.target.z += (mz / m) * speed;
      }
      if (k.has("q")) this.yaw += 1.1 * dt;
      if (k.has("e")) this.yaw -= 1.1 * dt;

      if (!this.userMoved) this.followAction(dt);

      const t = this.game.terrain;
      this.target.x = A.clamp(this.target.x, -t.width / 2 - 20, t.width / 2 + 20);
      this.target.z = A.clamp(this.target.z, -t.depth / 2 - 20, t.depth / 2 + 20);
      this.apply();
    }

    /**
     * Until the player touches the camera, it drifts to keep the fighting in frame. The moment they
     * pan, zoom or rotate it stops for good — an RTS camera that keeps stealing itself back is worse
     * than one that never helps at all.
     */
    followAction(dt) {
      let sx = 0;
      let sz = 0;
      let n = 0;
      for (const u of this.game.units) {
        if (u.state === "gone") continue;
        const w = u.contactsAgainst > 0 || u.contactsOn > 0 ? 4 : 1;
        sx += u.pos.x * w;
        sz += u.pos.z * w;
        n += w;
      }
      if (!n) return;
      const k = 1 - Math.exp(-0.8 * dt);
      this.target.x += (sx / n - this.target.x) * k;
      this.target.z += (sz / n + 8 - this.target.z) * k;
    }

    apply() {
      // Zoomed out you want a map; zoomed in you want to see faces. Pitch follows the wheel.
      const k = (this.dist - MIN_DIST) / (MAX_DIST - MIN_DIST);
      const pitch = A.lerp(0.58, 0.98, k);
      const h = this.dist * Math.cos(pitch);
      this.target.y = this.game.terrain.heightAt(this.target.x, this.target.z);
      this.camera.position.set(
        this.target.x + Math.sin(this.yaw) * h,
        this.target.y + this.dist * Math.sin(pitch),
        this.target.z + Math.cos(this.yaw) * h,
      );
      this.camera.lookAt(this.target);
    }
  };
})((window.Anchor = window.Anchor || {}));

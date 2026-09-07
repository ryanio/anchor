/** Seeded randomness, so a battle can be replayed and a screenshot is reproducible. */
(function (A) {
  "use strict";

  /** mulberry32 — small, fast, good enough for scattering men and rolling casualties. */
  A.makeRng = function makeRng(seed) {
    let a = seed >>> 0;
    const next = function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    next.range = (lo, hi) => lo + next() * (hi - lo);
    next.int = (n) => Math.floor(next() * n) % n;
    next.pick = (arr) => arr[next.int(arr.length)];
    /** Roughly normal, mean 0, sd ~0.4. Used for jitter that should cluster near zero. */
    next.gauss = () => (next() + next() + next() - 1.5) * 0.8;
    return next;
  };

  A.clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  A.lerp = (a, b, t) => a + (b - a) * t;

  /** Shortest signed angle from `a` to `b`, in (-PI, PI]. */
  A.angleDelta = function (a, b) {
    let d = (b - a) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d <= -Math.PI) d += Math.PI * 2;
    return d;
  };
})((window.Anchor = window.Anchor || {}));

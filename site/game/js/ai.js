/**
 * The opposing general. Deliberately shallow — it advances its line, feeds its spears to whatever
 * horse it can see, and sends its own cavalry the long way round to hit something in the back.
 * That last behaviour is the only clever thing in here, and it is enough: an AI that flanks teaches
 * the player what flanking is worth far faster than any tutorial.
 */
(function (A) {
  "use strict";

  const forward = (f) => [Math.sin(f), Math.cos(f)];
  const right = (f) => [Math.cos(f), -Math.sin(f)];
  const dist2 = (a, b) => (a.pos.x - b.pos.x) ** 2 + (a.pos.z - b.pos.z) ** 2;

  A.AI = {
    update(game, side, now) {
      const mine = game.units.filter((u) => u.side === side && u.isActive);
      const foes = game.units.filter((u) => u.side !== side && u.isActive);
      if (!foes.length) return;

      // Load is counted from standing assignments, not just the units retargeting this tick —
      // computing it per tick let the whole army pile onto one warband.
      const load = new Map();
      for (const u of mine) {
        if (u.aiTarget && u.aiTarget.isActive) load.set(u.aiTarget, (load.get(u.aiTarget) || 0) + 1);
      }

      for (const u of mine) {
        if (u.aiNext === undefined) u.aiNext = 0;
        if (now < u.aiNext) continue;
        u.aiNext = now + 0.7 + game.rng() * 0.6;

        // In contact: stand and fight. Walking out of a melee is how you lose one.
        if (u.contactsAgainst > 0 || u.contactsOn > 0) {
          u.ai = null;
          continue;
        }
        if (u.aiTarget && !u.aiTarget.isActive) u.aiTarget = null;

        if (u.type === "cavalry") this.rideAround(game, u, foes, now);
        else this.advance(u, foes, load);
      }
    },

    /** Infantry: walk at the nearest enemy, spreading out rather than stacking four-on-one. */
    advance(u, foes, load) {
      let best = null;
      let bestScore = Infinity;
      for (const f of foes) {
        let score = dist2(u, f);
        score *= 1 + (load.get(f) || 0) * 0.9;
        // Spearmen exist to meet horse. Let them.
        if (u.type === "spear" && f.type === "cavalry") score *= 0.25;
        if (u.type === "sword" && f.type === "spear") score *= 0.7;
        if (score < bestScore) { bestScore = score; best = f; }
      }
      if (!best) return;
      if (u.aiTarget !== best) {
        if (u.aiTarget) load.set(u.aiTarget, Math.max(0, (load.get(u.aiTarget) || 1) - 1));
        load.set(best, (load.get(best) || 0) + 1);
        u.aiTarget = best;
      }

      const dx = best.pos.x - u.pos.x;
      const dz = best.pos.z - u.pos.z;
      const d = Math.hypot(dx, dz) || 1;
      const stop = best.halfDepth + u.halfDepth - 0.6;
      u.orderMove(best.pos.x - (dx / d) * stop, best.pos.z - (dz / d) * stop, Math.atan2(dx, dz));
    },

    /**
     * Cavalry: find something already pinned by friendly infantry, swing wide of its front, then
     * come in behind it. Charging a formed spear wall head-on is how horse dies, so it is avoided
     * unless the spears already have their hands full.
     */
    rideAround(game, u, foes, now) {
      let target = u.ai && u.ai.target;
      if (!target || !target.isActive || now > (u.ai ? u.ai.expires : 0)) {
        let best = null;
        let bestScore = Infinity;
        for (const f of foes) {
          const pinned = f.contactsAgainst > 0;
          let score = dist2(u, f);
          if (pinned) score *= 0.28;                        // a busy enemy cannot turn to face you
          if (f.type === "spear" && !pinned) score *= 6;     // do not ride onto braced spears
          if (f.type === "cavalry") score *= 1.6;
          if (score < bestScore) { bestScore = score; best = f; }
        }
        if (!best) return;
        target = best;
        u.ai = { target, phase: "swing", expires: now + 9 };
      }

      const [fx, fz] = forward(target.facing);
      const [rx, rz] = right(target.facing);
      const relX = u.pos.x - target.pos.x;
      const relZ = u.pos.z - target.pos.z;
      const behindness = -(relX * fx + relZ * fz); // positive when we are already behind them
      const side = relX * rx + relZ * rz >= 0 ? 1 : -1;

      if (u.ai.phase === "swing" && behindness < target.halfDepth + 4) {
        const wx = target.pos.x + rx * side * 34 - fx * 8;
        const wz = target.pos.z + rz * side * 34 - fz * 8;
        u.orderMove(wx, wz, target.facing);
        if ((u.pos.x - wx) ** 2 + (u.pos.z - wz) ** 2 < 90) u.ai.phase = "charge";
        return;
      }

      u.ai.phase = "charge";
      const stop = target.halfDepth + u.halfDepth - 1.0;
      u.orderMove(target.pos.x - fx * stop, target.pos.z - fz * stop, target.facing);
    },
  };
})((window.Anchor = window.Anchor || {}));

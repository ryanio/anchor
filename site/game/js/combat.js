/**
 * Melee and morale.
 *
 * Contact is measured man-by-man rather than block-by-block: every frame the living soldiers go into
 * a spatial hash and each one looks for an enemy within reach. The number that comes out — how many
 * of my men are actually touching yours — is what scales the killing. That is why a wide line beats
 * a deep one on the front, why a unit caught in the open by two enemies at once evaporates, and why
 * an attack that lands on a flank counts every man in the file instead of just the front rank.
 *
 * Flanking is the point of the whole system. It multiplies damage, but far more importantly it
 * multiplies morale pressure, so a flanked unit almost always breaks and runs long before it dies.
 */
(function (A) {
  "use strict";

  const CELL = 2.4;
  const KILL_RATE = 0.042;    // kills per second, per man in contact, at parity
  const FRONT_ARC = 1.05;     // ±60° counts as the front
  const FLANK_ARC = 2.09;     // ±120°; anything beyond is the rear
  const FLANK_TIER = 1.2;     // damage ×2.2, and 41 points of morale pressure
  const REAR_TIER = 2.5;      // damage ×3.5, and 85 points — nothing survives that for long
  const ROUT_AT = 20;

  const grid = new Map();
  const touched = new Set();
  const pairs = new Map();

  function key(x, z) {
    return ((Math.floor(x / CELL) + 4096) << 13) | (Math.floor(z / CELL) + 4096);
  }

  A.Combat = {
    resolve(game, dt, now) {
      const units = game.units.filter((u) => u.state !== "gone");

      const wasEngaged = new Map();
      for (const u of units) {
        wasEngaged.set(u, u.contactsOn > 0 || u.contactsAgainst > 0);
        u.contactsOn = 0;
        u.contactsAgainst = 0;
        u.frontContacts = 0;
        u.worstFlank = 0;
        u.attackers.clear();
        u.threatX = 0;
        u.threatZ = 0;
        u._threatW = 0;
        for (const s of u.soldiers) {
          if (!s.alive) continue;
          s.pushX = 0;
          s.pushZ = 0;
          s.fighting = false;
        }
      }

      // ── spatial hash of every living man ─────────────────────────────────
      grid.clear();
      for (const u of units) {
        for (const s of u.soldiers) {
          if (!s.alive) continue;
          const k = key(s.x, s.z);
          let bucket = grid.get(k);
          if (!bucket) grid.set(k, (bucket = []));
          bucket.push(u, s);
        }
      }

      // ── who is touching whom ─────────────────────────────────────────────
      pairs.clear();
      for (const u of units) {
        const reach2 = u.def.reach * u.def.reach;
        for (const s of u.soldiers) {
          if (!s.alive) continue;
          touched.clear();
          let nearest = null;
          let nearestD = Infinity;
          const cx = Math.floor(s.x / CELL);
          const cz = Math.floor(s.z / CELL);
          for (let ix = -1; ix <= 1; ix++) {
            for (let iz = -1; iz <= 1; iz++) {
              const bucket = grid.get(
                (((cx + ix) + 4096) << 13) | ((cz + iz) + 4096),
              );
              if (!bucket) continue;
              for (let i = 0; i < bucket.length; i += 2) {
                const other = bucket[i];
                if (other.side === u.side) continue;
                const os = bucket[i + 1];
                const d2 = (os.x - s.x) ** 2 + (os.z - s.z) ** 2;
                if (d2 > reach2) continue;
                if (d2 < nearestD) { nearestD = d2; nearest = os; }
                if (!touched.has(other.id)) {
                  touched.add(other.id);
                  const pk = u.id * 100000 + other.id;
                  const rec = pairs.get(pk);
                  if (rec) rec.n++;
                  else pairs.set(pk, { a: u, b: other, n: 1 });
                }
              }
            }
          }
          if (nearest) {
            // Press into the man in front of you. Turns a tidy grid into a scrum on contact.
            // Press into the man in front of you, but stop pressing once you are on him —
            // an unclamped push had the two lines walking through each other into one mob.
            const d = Math.sqrt(nearestD) || 1;
            const press = A.clamp((d - 0.85) * 0.9, 0, 0.42);
            s.pushX = ((nearest.x - s.x) / d) * press;
            s.pushZ = ((nearest.z - s.z) / d) * press;
            s.faceWant = Math.atan2(nearest.x - s.x, nearest.z - s.z);
            s.fighting = true;
          }
        }
      }

      // ── casualties ───────────────────────────────────────────────────────
      for (const { a, b, n } of pairs.values()) {
        if (a.state === "routing") continue; // men running away do not fight back

        const rel = Math.abs(
          A.angleDelta(b.facing, Math.atan2(a.pos.x - b.pos.x, a.pos.z - b.pos.z)),
        );
        const tier = rel < FRONT_ARC ? 0 : rel < FLANK_ARC ? FLANK_TIER : REAR_TIER;

        let charge = 1;
        if (a.chargeTimer > 0) {
          charge = 1 + (a.def.charge - 1) * (a.chargeTimer / a.def.chargeDur);
          // A spear wall in good order stops a frontal charge dead. Ride round it instead.
          if (a.type === "cavalry" && b.type === "spear" && tier === 0) charge = 1;
        }
        const hA = game.terrain.heightAt(a.pos.x, a.pos.z);
        const hB = game.terrain.heightAt(b.pos.x, b.pos.z);
        const ground = 1 + A.clamp((hA - hB) * 0.14, -0.28, 0.28);
        const chasing = b.state === "routing" ? 3.0 : 1;
        const defense = b.def.defense * (b.state === "routing" ? 0.6 : 1);

        const kills =
          (KILL_RATE * a.def.attack * n * (1 + tier) *
            A.MATCHUP[a.type][b.type] * charge * ground * chasing * dt) / defense;

        b.killAccum += kills;
        while (b.killAccum >= 1) {
          b.killAccum -= 1;
          b.killNearest(a.pos.x, a.pos.z, now);
          if (b.state === "gone") break;
        }

        a.contactsOn += n;
        b.contactsAgainst += n;
        if (tier === 0) b.frontContacts += n;
        b.worstFlank = Math.max(b.worstFlank, tier);
        b.attackers.add(a);
        b.threatX += a.pos.x * n;
        b.threatZ += a.pos.z * n;
        b._threatW += n;
      }

      for (const u of units) {
        u.frontShare = u.contactsAgainst > 0 ? u.frontContacts / u.contactsAgainst : 1;
        if (u._threatW > 0) {
          u.threatX /= u._threatW;
          u.threatZ /= u._threatW;
        }
        // A block that hits home at a run gets a few seconds of shock value. Cavalry lives on it.
        const engagedNow = u.contactsOn > 0 || u.contactsAgainst > 0;
        if (engagedNow && !wasEngaged.get(u) && u.speedNow > u.def.speed * 0.4) {
          u.chargeTimer = u.def.chargeDur;
        }
      }

      this.morale(game, units, dt, now);
    },

    /**
     * Morale is where flanking actually wins battles. A unit taken in the rear picks up 85 points of
     * pressure instantly — more than it would get from losing half its men — so it breaks in seconds,
     * while the men who broke it have barely drawn blood.
     */
    morale(game, units, dt, now) {
      const routers = units.filter((u) => u.state === "routing");

      for (const u of units) {
        if (u.state === "routing" || u.state === "gone") continue;

        let panicky = 0;
        for (const r of routers) {
          if (r.side !== u.side) continue;
          if ((r.pos.x - u.pos.x) ** 2 + (r.pos.z - u.pos.z) ** 2 < 26 * 26) panicky++;
        }

        let pressure =
          u.lossFraction * 175 +                                  // the butcher's bill
          (u.recentLosses(now) / u.initial) * 90 +                // and how fast it is arriving
          u.worstFlank * 34 +                                     // being hit from the side or back
          Math.max(0, u.contactsAgainst - u.contactsOn) * 2.0 +   // locally outnumbered
          Math.max(0, u.attackers.size - 1) * 12 +                // surrounded
          panicky * 16 -                                          // friends streaming past in flight
          u.def.steadiness;
        if (u.contactsOn > u.contactsAgainst * 1.5) pressure -= 8; // winning steadies a line

        const target = A.clamp(100 - pressure, 0, 100);
        // Falls fast, recovers slowly: a unit that has been broken once is not the same afterwards.
        const k = target < u.morale ? 1.7 : 0.32;
        u.morale += (target - u.morale) * Math.min(1, k * dt);

        if (u.morale <= ROUT_AT) {
          u.state = "routing";
          u.routTimer = 0;
          u.chargeTimer = 0;
          game.onRout(u);
        }
      }
    },
  };
})((window.Anchor = window.Anchor || {}));

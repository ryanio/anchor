---
title: "A Rome: Total War battle, in 1800 lines of no-dependency JavaScript"
date: "2026-09-07"
summary: "A side project with no business case: two armies, forty men to a formation, and a morale system tuned until flanking felt as decisive as it did when I was twelve."
---

This one is not on the roadmap. I played *Rome: Total War* as a kid, and the thing I remember is not the campaign map or the unit roster — it is the moment a cavalry wedge comes in behind a line of spearmen and the whole formation dissolves. Not dies. *Dissolves.* Men who were holding a shield wall a second ago are running, and you did it with twenty-four horsemen against forty infantry.

I wanted that specific feeling in a browser tab, so [anchor.ryanio.com/game/](/game/) is now a small real-time battle. One engagement, two armies, twelve formations, four hundred-odd men. No build step, no npm dependency — three.js off a CDN and nine hand-written files.

## Formations first, soldiers second

The first decision was the only one that really mattered: the simulation is about **blocks**, not men. Orders, casualties, morale and routing all resolve on the formation. The forty soldiers inside are chasing slots in a grid and exist purely so the block reads as an army rather than a marker.

That split is what makes the whole thing cheap. One `InstancedMesh` per unit means forty men cost one draw call, and the geometry is boxes welded together — a torso, a helmet, a shield, a cloak. At the distance an RTS camera actually sits, nobody can tell that a legionary is nine cuboids.

Except that they can tell one thing, and it took a screenshot to notice: **the camera spends most of its life looking at the backs of your own men.** The shield carries the army colour and the shield is on the left arm, so from behind, my Roman line was a block of beige. Adding a cloak in the livery colour to the back of every soldier fixed the readability of the entire game in four lines.

## Flanking, and the four seconds that make it work

Contact is measured man by man. Every frame the living soldiers go into a spatial hash and each one looks for an enemy within reach; the number that falls out — how many of *my* men are actually touching *yours* — is what scales the killing. A wide line beats a deep one because more of it is in contact. A unit caught by two enemies at once evaporates because both contributions add.

Then the angle. For each pair, the attacker's position is measured against the defender's facing: inside ±60° is the front, out to ±120° is the flank, beyond that is the rear. Damage multiplies by 2.2 and 3.5 respectively, which is nice, but that is not what makes flanking decisive. What makes it decisive is that **the same angle feeds morale far harder than it feeds casualties**. A flank is 41 points of morale pressure; a rear attack is 85 — more than a unit picks up from losing half its men. So a flanked formation routs at about 18% casualties, and a formation charged in the back routs almost immediately. The men who broke it have barely drawn blood.

Then a correction that I think is the single best thing in here. Early on, a flank was permanent: once you were round the side you stayed round the side, and the game became "always attack from behind," which is not a tactic, it is an exploit. Now a formation in melee slowly wheels to face whatever is hitting it — but only at 0.3 radians a second, and only if its front is not already busy.

That one condition is the whole game. Charge a fresh unit in the flank and you get about four seconds before it turns and the bonus evaporates. Pin it frontally *first* and it can never turn at all. So the winning play is the real one: fix the enemy line with your infantry, then send the horse the long way round. I did not design that; it fell out of the condition, and finding it in the playtest was the best hour of the build.

## What the screenshots caught that I would not have

I built this against headless Chromium, taking screenshots and looking at them. Three bugs I would otherwise have shipped:

- **The field was corduroy.** My terrain colouring summed two sine waves for variation, and at the camera's actual distance the wavelength landed at about 110 pixels. The whole map looked like it was out of focus. Height does the work now, with per-vertex speckle for grain.
- **Two armies walked through each other.** Formations had no volume, so a battle turned into one interpenetrating mob. Units now push apart as oriented *rectangles* — a circle approximation is hopeless for a block ten men wide and four deep — with a small negative bias so the front ranks still reach.
- **The men pressed straight through the enemy line.** Each soldier in contact leans toward his nearest opponent, which turns a tidy grid into a scrum. Unclamped, that lean carried them clean through. It stops now once he is on top of him.

A fourth thing was not a bug but a decision. The game takes a `?t=45` parameter that fast-forwards the simulation before the first frame, and `?auto=1` to let the AI command both sides. Both exist so I could screenshot a real battle at minute one rather than a deployment screen — and then they turned out to be the balance harness too. Running six seeds to a decision took two seconds and told me that a passive Roman player loses every time in about 75 seconds, while one that uses its cavalry wins three times in four. That is exactly the difficulty curve I wanted, and I would have had no idea without it.

## ES modules do not work from a file

The last thing, and the reason the source looks slightly old-fashioned. I wanted the page to work when it is double-clicked as well as when it is served. Chrome refuses to fetch ES modules over `file://` — opaque origin, CORS — so a page split into `import`ed modules is blank on disk.

Classic scripts have no such restriction. So the nine game files are plain scripts that hang their exports off one `Anchor` global, and a single *inline* module — inline, so nothing is fetched from disk — pulls three.js off the CDN, publishes it as `window.THREE` and starts the battle. It cost me one bug (module-level `new THREE.Matrix4()` scratch objects ran before the module had published anything) and bought a game you can email to someone as a zip.

## What I cut

Rallying, so a broken unit is broken for good. Ranged troops — javelins would have needed projectiles and a whole second damage model for one more unit type. Real shadows, because software WebGL in CI is slow enough already; a soft ground blob under each formation does more for the "block of men" read than a shadow map would. Dust behind the cavalry, which I still want.

The corpses stayed, though, and they were nearly the cheapest thing in the file. Every man who dies leaves a slab on the ground where he fell, and by the end of a battle you can read the whole engagement off the field — where the line stood, where it bent, and the long scatter of bodies behind wherever it finally broke.

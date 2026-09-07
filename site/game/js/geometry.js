/**
 * Procedural geometry. Nothing here is loaded from disk or the network: soldiers, horses, banners
 * and trees are boxes welded together and given baked vertex colours, which is all an RTS camera
 * ever resolves. One merged geometry per (unit type, side) means one InstancedMesh per unit and
 * one draw call for forty men.
 */
(function (A) {
  "use strict";

  /** A coloured box, pre-transformed into soldier-local space. */
  function box(w, h, d, x, y, z, color, rot) {
    const g = new THREE.BoxGeometry(w, h, d);
    if (rot) {
      if (rot[0]) g.rotateX(rot[0]);
      if (rot[1]) g.rotateY(rot[1]);
      if (rot[2]) g.rotateZ(rot[2]);
    }
    g.translate(x, y, z);
    const c = new THREE.Color(color);
    const n = g.attributes.position.count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      col[i * 3] = c.r;
      col[i * 3 + 1] = c.g;
      col[i * 3 + 2] = c.b;
    }
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    return g;
  }
  A.box = box;

  /**
   * Merge indexed BufferGeometries that share position/normal/color. three's BufferGeometryUtils
   * lives in the addons bundle, and pulling a second file off the CDN for thirty lines of array
   * copying is not a trade worth making.
   */
  function merge(parts) {
    let verts = 0;
    let indices = 0;
    for (const p of parts) {
      verts += p.attributes.position.count;
      indices += p.index.count;
    }
    const pos = new Float32Array(verts * 3);
    const nor = new Float32Array(verts * 3);
    const col = new Float32Array(verts * 3);
    const idx = verts > 65535 ? new Uint32Array(indices) : new Uint16Array(indices);
    let vo = 0;
    let io = 0;
    for (const p of parts) {
      const n = p.attributes.position.count;
      pos.set(p.attributes.position.array, vo * 3);
      nor.set(p.attributes.normal.array, vo * 3);
      col.set(p.attributes.color.array, vo * 3);
      const pi = p.index.array;
      for (let i = 0; i < pi.length; i++) idx[io + i] = pi[i] + vo;
      vo += n;
      io += pi.length;
      p.dispose();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeBoundingSphere();
    return g;
  }
  A.mergeGeometry = merge;

  const SKIN = 0xc79b6e;
  const IRON = 0x8d949c;
  const WOOD = 0x6b4b2f;
  const STEEL = 0xb9c2c9;

  /**
   * A single soldier, facing local +Z, feet at y = 0. `livery` is the army colour and carries almost
   * all of the readability at RTS zoom — it is on the shield, which is the biggest flat face.
   */
  function soldier(kind, livery, tunic) {
    const p = [
      box(0.30, 0.44, 0.22, 0, 0.22, 0, 0x4a3a2a),            // legs
      box(0.38, 0.50, 0.27, 0, 0.67, 0, tunic),               // torso
      box(0.44, 0.13, 0.30, 0, 0.88, 0, 0x6f7680),            // shoulders — breaks the slab up
      // A cloak in the army's colour. The camera spends most of its life looking at the backs of
      // your own men, and without this a Roman line read as a block of beige from behind.
      box(0.40, 0.46, 0.06, 0, 0.70, -0.16, livery),
      box(0.21, 0.21, 0.21, 0, 1.06, 0.01, SKIN),             // head
      box(0.26, 0.13, 0.26, 0, 1.19, 0.01, IRON),             // helmet
      box(0.10, 0.15, 0.10, 0, 1.30, 0.01, livery),           // crest
    ];
    if (kind === "cavalry") throw new Error("cavalry uses rider()");
    if (kind === "spear") {
      p.push(box(0.07, 0.38, 0.38, -0.24, 0.68, 0.10, livery));                    // small round shield
      p.push(box(0.05, 2.60, 0.05, 0.26, 1.15, 0.22, WOOD, [-0.22, 0, 0]));        // pike shaft
      p.push(box(0.07, 0.28, 0.07, 0.26, 2.42, 0.52, STEEL, [-0.22, 0, 0]));       // pike head
    } else {
      p.push(box(0.08, 0.50, 0.36, -0.25, 0.64, 0.11, livery));                    // scutum
      p.push(box(0.06, 0.46, 0.06, 0.27, 0.86, 0.16, STEEL, [-0.75, 0, 0]));       // gladius
    }
    return merge(p);
  }

  /** Horse plus rider, facing local +Z. */
  function horseman(livery, tunic, coat) {
    const p = [
      box(0.46, 0.50, 1.30, 0, 0.98, 0.00, coat),               // barrel
      box(0.30, 0.46, 0.30, 0, 1.22, 0.62, coat, [0.55, 0, 0]), // neck
      box(0.22, 0.24, 0.44, 0, 1.42, 0.92, coat),               // head
      box(0.13, 0.80, 0.13, 0.17, 0.40, 0.44, coat),
      box(0.13, 0.80, 0.13, -0.17, 0.40, 0.44, coat),
      box(0.13, 0.80, 0.13, 0.17, 0.40, -0.44, coat),
      box(0.13, 0.80, 0.13, -0.17, 0.40, -0.44, coat),
      box(0.09, 0.42, 0.09, 0, 1.10, -0.70, coat, [0.5, 0, 0]), // tail
      box(0.34, 0.50, 0.26, 0, 1.48, 0.02, tunic),              // rider torso
      box(0.36, 0.44, 0.06, 0, 1.50, -0.15, livery),            // rider's cloak
      box(0.50, 0.10, 0.80, 0, 1.24, -0.10, livery),            // saddle cloth
      box(0.44, 0.16, 0.22, 0, 1.28, 0.02, 0x4a3a2a),           // rider thighs
      box(0.20, 0.20, 0.20, 0, 1.82, 0.02, SKIN),
      box(0.25, 0.11, 0.25, 0, 1.93, 0.02, IRON),
      box(0.09, 0.14, 0.09, 0, 2.02, 0.02, livery),
      box(0.08, 0.42, 0.34, -0.26, 1.46, 0.12, livery),                       // shield
      box(0.05, 2.20, 0.05, 0.27, 1.60, 0.30, WOOD, [-1.25, 0, 0]),           // couched lance
      box(0.07, 0.24, 0.07, 0.27, 2.06, 1.34, STEEL, [-1.25, 0, 0]),
    ];
    return merge(p);
  }

  /** Cache keyed on type+livery: six geometries serve a whole battlefield. */
  const cache = new Map();
  A.soldierGeometry = function (kind, livery, tunic, coat) {
    const key = kind + ":" + livery + ":" + tunic;
    let g = cache.get(key);
    if (!g) {
      g = kind === "cavalry" ? horseman(livery, tunic, coat) : soldier(kind, livery, tunic);
      cache.set(key, g);
    }
    return g;
  };

  /** The standard that marks a unit's centre — the thing your eye actually tracks in Total War. */
  A.bannerGeometry = function (livery) {
    return merge([
      box(0.07, 3.30, 0.07, 0, 1.65, 0, 0x40301f),
      box(0.14, 0.16, 0.14, 0, 3.36, 0, 0xc9a441),
      box(0.03, 0.62, 0.86, 0.01, 3.00, 0.45, livery),
      box(0.04, 0.10, 0.86, 0.01, 2.68, 0.45, 0xc9a441),
    ]);
  };

  /** A fallen man: a flat slab, scattered face-down. Corpses are how a battle line tells its story. */
  A.corpseGeometry = function (livery) {
    return merge([
      box(0.52, 0.13, 0.26, 0, 0.065, 0, 0x3a2c20),
      box(0.17, 0.10, 0.17, 0.32, 0.05, 0, 0x8a7052),
      box(0.30, 0.07, 0.30, -0.20, 0.09, 0.10, livery),
    ]);
  };

  A.treeGeometry = function () {
    return merge([
      box(0.42, 2.4, 0.42, 0, 1.2, 0, 0x4b3826),
      box(3.0, 2.2, 3.0, 0, 3.1, 0, 0x3f5a2e),
      box(2.1, 1.8, 2.1, 0, 4.4, 0, 0x4a6b36),
    ]);
  };

  /** Soft radial blob, generated in a canvas — the ground shade under a formation. */
  A.blobTexture = function () {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const ctx = c.getContext("2d");
    const grd = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, "rgba(255,255,255,1)");
    grd.addColorStop(0.55, "rgba(255,255,255,0.75)");
    grd.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, 64, 64);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
})((window.Anchor = window.Anchor || {}));

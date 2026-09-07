/**
 * The HTML layer. Everything here is read-only reporting on the simulation: army strength, the cards
 * for whatever is selected, and a small bar floating over each formation so you can read the state of
 * the whole line at a glance without zooming in.
 */
(function (A) {
  "use strict";

  const $ = (id) => document.getElementById(id);

  A.Hud = class Hud {
    constructor(game) {
      this.game = game;
      this.markers = $("markers");
      this.selectionEl = $("selection");
      this.toastEl = $("toast");
      this.resultEl = $("result");
      this.bars = [$("bar0"), $("bar1")];
      this.men = [$("men0"), $("men1")];
      this.byUnit = new Map();
      this.cards = new Map();
      this.signature = "";
      this.toastUntil = 0;
      this.v = new THREE.Vector3();
      $("restart").addEventListener("click", () => game.restart());
    }

    reset() {
      this.markers.innerHTML = "";
      this.selectionEl.innerHTML = "";
      this.byUnit.clear();
      this.cards.clear();
      this.signature = "";
      this.resultEl.hidden = true;
      this.resultEl.className = "";
    }

    toast(msg, now) {
      this.toastEl.textContent = msg;
      this.toastEl.hidden = false;
      this.toastUntil = now + 2.8;
    }

    showResult(won, sub) {
      this.resultEl.hidden = false;
      this.resultEl.className = won ? "win" : "lose";
      $("result-title").textContent = won ? "The field is yours" : "The line is broken";
      $("result-sub").textContent = sub;
    }

    update(now) {
      const g = this.game;
      if (!this.toastEl.hidden && now > this.toastUntil) this.toastEl.hidden = true;

      for (const side of [0, 1]) {
        const units = g.units.filter((u) => u.side === side);
        const alive = units.reduce((n, u) => n + (u.state === "gone" ? 0 : u.alive), 0);
        const steady = units.reduce((n, u) => n + (u.isActive ? u.alive : 0), 0);
        const total = g.startingMen[side];
        this.bars[side].style.width = ((steady / total) * 100).toFixed(1) + "%";
        this.men[side].textContent = steady + " / " + total + (alive > steady ? " ⚑" : "");
      }

      this.updateMarkers();
      this.updateSelection();
    }

    updateMarkers() {
      const g = this.game;
      const cam = g.camera;
      for (const u of g.units) {
        let el = this.byUnit.get(u);
        if (!el) {
          el = document.createElement("div");
          el.className = "marker";
          el.innerHTML = '<div class="m-bar"><i></i></div><div class="m-tag"></div>';
          this.markers.appendChild(el);
          this.byUnit.set(u, el);
        }
        if (u.state === "gone") { el.style.display = "none"; continue; }

        this.v.set(u.pos.x, g.terrain.heightAt(u.pos.x, u.pos.z) + 4.2, u.pos.z);
        this.v.project(cam);
        if (this.v.z > 1 || Math.abs(this.v.x) > 1.15 || Math.abs(this.v.y) > 1.15) {
          el.style.display = "none";
          continue;
        }
        el.style.display = "";
        el.style.left = ((this.v.x + 1) / 2) * innerWidth + "px";
        el.style.top = ((1 - this.v.y) / 2) * innerHeight + "px";
        el.classList.toggle("sel", u.selected);

        const fill = el.firstChild.firstChild;
        fill.style.width = ((u.alive / u.initial) * 100).toFixed(0) + "%";
        // The bar carries two numbers at once: length is men, colour is nerve.
        fill.style.background =
          u.state === "routing" ? "#ff6a4d"
            : u.side === 0
              ? "hsl(" + (10 + u.morale * 0.28).toFixed(0) + ", 72%, 55%)"
              : "hsl(" + (212 - (100 - u.morale) * 0.9).toFixed(0) + ", 62%, 58%)";
        el.lastChild.textContent = u.state === "routing" ? "ROUTING" : "";
      }
    }

    updateSelection() {
      const sel = this.game.selected;
      const sig = sel.map((u) => u.id).join(",");
      if (sig !== this.signature) {
        this.signature = sig;
        this.selectionEl.innerHTML = "";
        this.cards.clear();
        for (const u of sel) {
          const el = document.createElement("div");
          el.className = "card";
          el.innerHTML =
            "<h4></h4><div class='row'><span class='men'></span><span class='mor'></span></div>" +
            "<div class='meter'><i></i></div><div class='state'></div>";
          el.querySelector("h4").textContent = u.name;
          this.selectionEl.appendChild(el);
          this.cards.set(u, el);
        }
      }
      for (const [u, el] of this.cards) {
        el.classList.toggle("routing", u.state === "routing");
        el.querySelector(".men").textContent = u.alive + "/" + u.initial;
        el.querySelector(".mor").textContent = Math.round(u.morale) + "%";
        const m = el.querySelector(".meter i");
        m.style.width = u.morale.toFixed(0) + "%";
        m.style.background = u.morale > 55 ? "#7fb069" : u.morale > 30 ? "#e0b566" : "#d8503a";
        el.querySelector(".state").textContent =
          u.displayState + (u.worstFlank >= 2.5 ? " · rear!" : u.worstFlank > 0 ? " · flanked!" : "");
      }
    }
  };
})((window.Anchor = window.Anchor || {}));

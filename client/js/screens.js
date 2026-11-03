// ---------------------------------------------------------------------------
// Screens + HUD (all 10 required surfaces). Polished-but-pragmatic DOM UI:
// welcome/login -> character select -> main menu -> celebrate with world -> HUD with
// friends/players/voice/settings panels, chat, emotes, invites, profile.
// ---------------------------------------------------------------------------
import * as THREE from "three";
import { CharacterRig, SKIN, HAIRS } from "./actors.js";
import { loadProfile, saveProfile } from "./net.js";
import { isMobileDevice, lockLandscape } from "./orientation.js";
import {
  FIREWORKS,
  SHOPS,
  CURRENCY,
  fireworkById,
} from "../shared/constants.js";

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

// distinct, resolution-free icons for the catalog (emoji render everywhere the
// game already runs — no image downloads, matching the asset-free design)
const FX_EMOJI = {
  anar: "🎇",
  chakri: "🌀",
  phuljhadi: "✨",
  rocket: "🚀",
  aerial: "🎆",
  pack: "📦",
  combo: "🎁",
};
const COIN = CURRENCY.symbol;

export class UI {
  constructor(game) {
    this.game = game;
    this.screensEl = $("screens");
    this.screens = {};
    this.pendingInvites = new Map();
    this.pmTo = null; // {id, name} for private messages
    this.settings = this._loadSettings();

    this._buildScreens();
    this._bindHud();

    // keep the voice panel live while open; apply saved speaker volume
    this.game.voice.on("change", () => {
      const panel = $("voice-panel");
      if (panel && !panel.hidden) this._renderVoicePanel();
    });
    this.game.voice.setSpeakerVolume((this.settings.voiceVol ?? 80) / 100);
    this.game.setTimeOfDay(this.settings.timeOfDay);
    this._syncTimeButton?.();
  }

  // =========================================================================
  // boot flow
  // =========================================================================
  bootFlow() {
    const prof = loadProfile();
    if (!prof.name) this.show("welcome");
    else {
      $("cc-name").value = prof.name;
      this.show("character");
    }
  }

  show(id) {
    for (const [key, node] of Object.entries(this.screens)) {
      node.classList.toggle("active", key === id);
    }
    this.current = id;
  }

  hideScreens() {
    this.show("__none__");
  }

  _register(id, title, build) {
    const node = el("div", "screen");
    node.dataset.screen = id;
    build(node);
    this.screens[id] = node;
    this.screensEl.appendChild(node);
    void title;
  }

  // =========================================================================
  // screen builders
  // =========================================================================
  _buildScreens() {
    // ---- 1. welcome / login ------------------------------------------------
    this._register("welcome", "Welcome", (n) => {
      const panel = el("div", "panel");
      panel.appendChild(el("h1", "brand", "Diwali Meet Up"));
      panel.appendChild(
        el(
          "p",
          "sub",
          "Your island to hang out. Meet buddies, chat, joke around.",
        ),
      );
      const nameField = el("div", "field");
      const lbl = el("label", "", "Display name");
      const inp = el("input", "");
      inp.maxLength = 20;
      inp.placeholder = "e.g. SunnyDown";
      nameField.append(lbl, inp);
      const btn = el("button", "btn", "Continue");
      btn.onclick = () => {
        const name = inp.value.trim();
        if (!name) {
          inp.focus();
          return;
        }
        this.game.setName(name);
        $("cc-name").value = name;
        this.show("character");
      };
      inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter") btn.onclick();
      });
      panel.append(nameField, btn);
      panel.appendChild(
        el(
          "p",
          "muted",
          "Prototype: identity is a local device key. Real accounts are on the roadmap.",
        ),
      );
      panel.style.marginTop = "0";
      n.appendChild(panel);
      setTimeout(() => inp.focus(), 350);
    });

    // ---- 2. character selection ------------------------------------------
    this._register("character", "Character", (n) => {
      const panel = el("div", "panel cc-panel");

      const head = el("div", "cc-head");
      head.appendChild(el("h2", "cc-title", "Create your buddy"));
      head.appendChild(
        el(
          "p",
          "cc-sub",
          "Style your buddy — every change updates the preview live.",
        ),
      );
      panel.appendChild(head);

      const body = el("div", "cc-body");
      const side = el("div", "cc-side");
      const form = el("div", "cc-form");

      const stage = el("div", "preview-stage");
      const note = el("span", "stage-note", "↔ Drag to rotate");
      stage.append(note);
      side.appendChild(stage);

      const stats = el("div", "stats");
      const s1 = el("div", "stat");
      s1.append(el("b", "", "Social"), el("span", "", "Free island"));
      const s2 = el("div", "stat");
      s2.append(el("b", "", "No combat"), el("span", "", "Just vibes"));
      const s3 = el("div", "stat");
      s3.append(el("b", "", "1 km²"), el("span", "", "To explore"));
      stats.append(s1, s2, s3);
      side.appendChild(stats);

      const nameField = el("div", "field");
      const lbl = el("label", "", "Display name");
      const inp = el("input", "");
      inp.id = "cc-name";
      inp.maxLength = 20;
      inp.placeholder = "Your name on the island";
      nameField.append(lbl, inp);
      form.appendChild(nameField);

      const field = (labelText) => {
        const f = el("div", "field");
        f.appendChild(el("label", "", labelText));
        return f;
      };
      const genderField = field("Character");
      const genderRow = el("div", "option-row gender-row");
      genderField.appendChild(genderRow);
      const skinField = field("Skin tone");
      const skinRow = el("div", "swatches");
      skinField.appendChild(skinRow);
      const hairField = field("Hairstyle");
      const hairRow = el("div", "option-row");
      hairField.appendChild(hairRow);
      const hairColField = field("Hair color");
      const hairColRow = el("div", "swatches");
      hairColField.appendChild(hairColRow);
      const glassField = field("Eyewear");
      const glassRow = el("div", "option-row");
      glassField.appendChild(glassRow);
      form.append(genderField, skinField, hairField, hairColField, glassField);
      body.append(side, form);
      panel.appendChild(body);

      const foot = el("div", "cc-foot");
      const rand = el("button", "btn ghost cc-random");
      rand.type = "button";
      rand.append(
        el("span", "rnd-emoji", "🎲"),
        el("span", "rnd-label", "Surprise me"),
      );
      const go = el("button", "btn cc-go", "Enter →");
      go.type = "button";
      foot.append(rand, go);
      panel.appendChild(foot);
      n.appendChild(panel);

      // 3D avatar preview
      const prev = this._makePreview(stage);
      this.preview = prev;
      // legacy {b,h} profiles migrate into the gender/appearance model
      const legacy = loadProfile().av;
      this.game.previewAv = {
        g: legacy?.g === undefined ? 1 : legacy.g ? 1 : 0,
        b: legacy?.b ?? 0,
        h: legacy?.h ?? 0,
        y: legacy?.y ?? (legacy?.h ?? 0) % 3,
        e: legacy?.e ?? 0,
      };
      inp.value = loadProfile().name || "";

      const HAIR_LABELS = [
        ["Long", "Braid", "Bun"],
        ["Short", "Curly", "Topknot"],
      ];

      const rebuild = () => {
        prev.setAvatar(this.game.previewAv);
      };
      const sw = (parent, colors, key) => {
        colors.forEach((c, i) => {
          const s = el("button", "swatch");
          s.type = "button";
          s.style.background = "#" + c.toString(16).padStart(6, "0");
          s.onclick = () => {
            this.game.previewAv[key] = i;
            parent
              .querySelectorAll(".selected")
              .forEach((x) => x.classList.remove("selected"));
            s.classList.add("selected");
            rebuild();
          };
          if ((this.game.previewAv[key] ?? 0) % colors.length === i)
            s.classList.add("selected");
          parent.appendChild(s);
        });
      };
      sw(skinRow, SKIN, "b");
      sw(hairColRow, HAIRS, "h");

      const genderPills = ["Female", "Male"].map((label, i) => {
        const pill = el("button", "pill", label);
        pill.type = "button";
        pill.onclick = () => {
          if (this.game.previewAv.g === i) return;
          this.game.previewAv.g = i;
          refreshLabels();
          syncSelection();
        };
        genderRow.appendChild(pill);
        return pill;
      });

      const stylePills = [0, 1, 2].map((i) => {
        const pill = el("button", "pill");
        pill.type = "button";
        pill.onclick = () => {
          this.game.previewAv.y = i;
          syncSelection();
        };
        hairRow.appendChild(pill);
        return pill;
      });
      const GLASS_LABELS = ["None", "Glasses", "Shades"];
      const glassPills = [0, 1, 2].map((i) => {
        const pill = el("button", "pill", GLASS_LABELS[i]);
        pill.type = "button";
        pill.onclick = () => {
          this.game.previewAv.e = i;
          syncSelection();
        };
        glassRow.appendChild(pill);
        return pill;
      });
      const refreshLabels = () => {
        const g = this.game.previewAv.g ?? 1;
        stylePills.forEach((p, i) => {
          p.textContent = HAIR_LABELS[g][i];
        });
      };

      const syncSelection = () => {
        const av = this.game.previewAv;
        const markRow = (row, colors, key) => {
          const idx = (av[key] ?? 0) % colors.length;
          [...row.children].forEach((s, i) =>
            s.classList.toggle("selected", i === idx),
          );
        };
        markRow(skinRow, SKIN, "b");
        markRow(hairColRow, HAIRS, "h");
        genderPills.forEach((x, i) =>
          x.classList.toggle("selected", (av.g ?? 1) === i),
        );
        stylePills.forEach((x, i) =>
          x.classList.toggle("selected", (av.y ?? 0) % 3 === i),
        );
        glassPills.forEach((x, i) =>
          x.classList.toggle("selected", (av.e ?? 0) % 3 === i),
        );
        rebuild();
      };
      rand.onclick = () => {
        const r = (m) => Math.floor(Math.random() * m);
        const av = this.game.previewAv;
        av.b = r(SKIN.length);
        av.h = r(HAIRS.length);
        av.y = r(3);
        av.e = r(3);
        syncSelection();
      };
      refreshLabels();
      syncSelection();

      // drag to rotate (pointer capture keeps the drag alive outside the stage;
      // a slow idle spin runs whenever the buddy isn't being dragged)
      let lastX = 0;
      stage.addEventListener("pointerdown", (e) => {
        prev.dragging = true;
        lastX = e.clientX;
        try {
          stage.setPointerCapture(e.pointerId);
        } catch {
          /* older browsers */
        }
      });
      stage.addEventListener("pointermove", (e) => {
        if (prev.dragging) {
          prev.orbit(e.clientX - lastX);
          lastX = e.clientX;
        }
      });
      for (const t of ["pointerup", "pointercancel", "pointerleave"]) {
        stage.addEventListener(t, () => {
          prev.dragging = false;
        });
      }
      inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter") go.onclick();
      });
      go.onclick = () => {
        const name = inp.value.trim() || loadProfile().name;
        if (!name) {
          inp.focus();
          return;
        }
        saveProfile({ name, av: this.game.previewAv });
        this.game.setName(name);
        this.show("menu");
      };
    });

    // ---- 3. main menu ------------------------------------------------------
    this._register("menu", "Menu", (n) => {
      const panel = el("div", "panel");
      panel.style.textAlign = "center";
      panel.appendChild(el("h1", "brand", "Diwali Meet Up"));
      const profPill = el("p", "sub");
      panel.appendChild(profPill);
      const b1 = el("button", "btn", "Celebrate with World");
      b1.onclick = () => this.game.enterWorld();
      const b2 = el("button", "btn ghost", "Friends");
      b2.onclick = () => {
        this._renderFriendsScreen();
        this.show("friends");
      };
      const b3 = el("button", "btn ghost", "Profile");
      b3.onclick = () => {
        this._renderProfileScreen();
        this.show("profileScreen");
      };
      const b4 = el("button", "btn ghost", "Settings");
      b4.onclick = () => this.show("settings");
      const b5 = el("button", "btn ghost", "Change character");
      b5.onclick = () => this.show("character");
      panel.append(b1, b2, b3, b4, b5);
      panel.querySelectorAll(".btn").forEach((b) => {
        b.style.margin = "6px 0";
      });
      n.appendChild(panel);
      n._profilePill = profPill;
    });

    // ---- settings ------------------------------------------------------- (8)
    this._register("settings", "Settings", (n) => {
      const panel = el("div", "panel");
      panel.appendChild(el("h2", "", "Settings"));
      const vol = el("div", "setting-row");
      vol.append(el("span", "", "Voice volume"));
      const vr = el("input");
      vr.type = "range";
      vr.min = 0;
      vr.max = 100;
      vr.value = this.settings.voiceVol;
      vr.oninput = () => {
        this.settings.voiceVol = Number(vr.value);
        this._saveSettings();
        this.game.voice.setSpeakerVolume(vr.value / 100);
      };
      vol.appendChild(vr);
      panel.appendChild(vol);

      const sens = el("div", "setting-row");
      sens.append(el("span", "", "Camera sensitivity"));
      const sr = el("input");
      sr.type = "range";
      sr.min = 30;
      sr.max = 200;
      sr.value = this.settings.sens;
      sr.oninput = () => {
        this.settings.sens = Number(sr.value);
        this._saveSettings();
        this.game.controller?.setSensitivity(this.settings.sens);
      };
      sens.appendChild(sr);
      panel.appendChild(sens);

      const back = el("button", "btn", "Back");
      back.onclick = () =>
        this.game.playing ? this.hideScreens() : this.show("menu");
      panel.appendChild(back);
      n.appendChild(panel);
    });

    // ---- profile screen (from menu) -------------------------------------- (9)
    this._register("profileScreen", "Profile", (n) => {
      const panel = el("div", "panel");
      panel.appendChild(el("h2", "", "Profile"));
      this.profileBody = el("div", "");
      panel.appendChild(this.profileBody);
      const back = el("button", "btn", "Back");
      back.onclick = () => this.show("menu");
      panel.appendChild(back);
      n.appendChild(panel);
    });

    // ---- friends screen -------------------------------------------------- (6)
    this._register("friends", "Friends", (n) => {
      const panel = el("div", "panel");
      panel.appendChild(el("h2", "", "Friends"));
      const addRow = el("div", "row");
      const inp = el("input", "");
      inp.id = "menu-friend-input";
      inp.maxLength = 20;
      inp.placeholder = "Player name";
      const add = el("button", "btn small", "Add");
      add.onclick = () => {
        if (inp.value.trim()) {
          this.game.net.send({
            t: "friend",
            op: "add",
            name: inp.value.trim(),
          });
          inp.value = "";
          toastInfo(this, "Request sent");
        }
      };
      addRow.append(inp, add);
      panel.appendChild(addRow);
      this.friendsBody = el("ul", "list");
      panel.appendChild(this.friendsBody);
      const back = el("button", "btn", "Back");
      back.onclick = () => this.show("menu");
      panel.appendChild(back);
      n.appendChild(panel);
    });

    // ---- Diwali firecracker shop (in-game modal) -------------------------
    this._register("shop", "Shop", (n) => {
      n.classList.add("in-game-dim");
      const panel = el("div", "panel shop-panel");
      const head = el("div", "shop-head");
      this.shopTitle = el("h2", "", "Firecracker Shop");
      const close = el("button", "icon-btn shop-close");
      close.setAttribute("aria-label", "Close shop");
      close.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18"/></svg>';
      close.onclick = () => this.closeShop();
      head.append(this.shopTitle, close);
      panel.appendChild(head);
      this.shopBalance = el("div", "shop-balance");
      panel.appendChild(this.shopBalance);
      panel.appendChild(
        el(
          "p",
          "muted shop-hint",
          `${COIN} Diwali Coins are a free in-game currency — never real money. Buy crackers, then equip and use them out on the island.`,
        ),
      );
      this.shopGrid = el("div", "product-grid");
      panel.appendChild(this.shopGrid);
      n.appendChild(panel);
      // click the dimmed backdrop to dismiss
      n.addEventListener("mousedown", (e) => {
        if (e.target === n) this.closeShop();
      });
    });

    // ---- firecracker inventory (in-game modal) ---------------------------
    this._register("inventory", "Inventory", (n) => {
      n.classList.add("in-game-dim");
      const panel = el("div", "panel inv-panel");
      const head = el("div", "shop-head");
      head.append(el("h2", "", "My Firecrackers"));
      const close = el("button", "icon-btn shop-close");
      close.setAttribute("aria-label", "Close inventory");
      close.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18"/></svg>';
      close.onclick = () => this.closeInventory();
      head.appendChild(close);
      panel.appendChild(head);
      this.invBalance = el("div", "shop-balance");
      panel.appendChild(this.invBalance);
      this.invBody = el("div", "inv-list");
      panel.appendChild(this.invBody);
      panel.appendChild(
        el(
          "p",
          "muted shop-hint",
          "Equip a cracker, then press F (or Use) in the world to light it. Phuljhadi is carried; the rest are placed on the ground.",
        ),
      );
      n.appendChild(panel);
      n.addEventListener("mousedown", (e) => {
        if (e.target === n) this.closeInventory();
      });
    });
  }

  _loadSettings() {
    let saved = {};
    try {
      saved = JSON.parse(
        localStorage.getItem("Diwali Meet Up.settings") || "{}",
      );
    } catch {
      saved = {};
    }
    return {
      quality: "high",
      timeOfDay: "night",
      voiceVol: 80,
      sens: 100,
      ...saved,
      quality: "high",
    };
  }
  _saveSettings() {
    localStorage.setItem(
      "Diwali Meet Up.settings",
      JSON.stringify(this.settings),
    );
  }

  // =========================================================================
  // HUD wiring
  // =========================================================================
  _bindHud() {
    $("chat-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const input = $("chat-input");
      const text = input.value.trim();
      if (!text) return;
      if (this.pmTo) {
        this.game.net.send({ t: "chat", text, to: this.pmTo.id });
        input.value = "";
        this.pmTo = null;
        input.placeholder = "Say something…";
        return;
      }
      this.game.net.send({ t: "chat", text });
      input.value = "";
    });
    $("chat-input").addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        this.pmTo = null;
        e.target.placeholder = "Say something…";
      }
      e.stopPropagation();
    });

    for (const b of document.querySelectorAll("#emote-bar button")) {
      b.addEventListener("click", () =>
        this.game.controller.playEmote(b.dataset.emote),
      );
    }

    $("btn-players").onclick = () => this.togglePlayers();
    $("btn-friends").onclick = () => this.toggleFriends();
    $("btn-voice").onclick = () => this.toggleVoice();
    $("btn-settings").onclick = () => this.show("settings");
    this._syncTimeButton = () => {
      const b = $("btn-timeofday");
      if (!b) return;
      const day = this.game.timeOfDay === "day";
      b.textContent = day ? "☾" : "☀";
      b.title = day ? "Switch to night" : "Switch to day";
      b.setAttribute("aria-label", b.title);
    };
    this._syncTimeButton();
    $("btn-timeofday").onclick = () => {
      const next = this.game.timeOfDay === "day" ? "night" : "day";
      this.settings.timeOfDay = next;
      this._saveSettings();
      this.game.setTimeOfDay(next);
      this._syncTimeButton();
    };
    const invBtn = $("btn-inventory");
    if (invBtn) invBtn.onclick = () => this.toggleInventory();

    // friend add from HUD panel
    $("friend-add-btn").onclick = () => {
      const v = $("friend-name-input").value.trim();
      if (v) {
        this.game.net.send({ t: "friend", op: "add", name: v });
        $("friend-name-input").value = "";
      }
    };

    this._bindFullscreen();
  }

  // =========================================================================
  // HUD panel + fullscreen helpers (shared by buttons and keyboard shortcuts)
  // =========================================================================
  showPlaying(fn) {
    if (this.game.playing) fn();
  }
  togglePlayers() {
    this.showPlaying(() => {
      this._renderPlayers();
      togglePanel("players-panel");
      closePanels("players-panel");
    });
  }
  toggleFriends() {
    this.showPlaying(() => {
      this._renderFriendsPanel();
      togglePanel("friends-panel");
      closePanels("friends-panel");
    });
  }
  toggleVoice() {
    this.showPlaying(() => {
      this._renderVoicePanel();
      togglePanel("voice-panel");
      closePanels("voice-panel");
    });
  }
  closePanels() {
    for (const k of ["players-panel", "friends-panel", "voice-panel"])
      $(k).hidden = true;
  }

  // ---- fullscreen (Fullscreen API, with webkit fallback for older Safari) --
  _bindFullscreen() {
    const btn = $("btn-fullscreen");
    if (!btn) return;
    const doc = document;
    const el = doc.documentElement;
    const request = el.requestFullscreen || el.webkitRequestFullscreen;
    const exit = doc.exitFullscreen || doc.webkitExitFullscreen;
    const current = () => doc.fullscreenElement || doc.webkitFullscreenElement;
    // iPhone Safari has no Element fullscreen: hide the button instead of
    // showing a control that can never work.
    this.toggleFullscreen = () => {};
    if (!request || !exit) {
      btn.hidden = true;
      return;
    }
    this.toggleFullscreen = () => {
      if (current()) {
        exit.call(doc);
        return;
      }
      const afterEnter = () => {
        if (isMobileDevice()) void lockLandscape();
      };
      const requestBare = () => {
        try {
          const p = request.call(el);
          if (p?.then) p.then(afterEnter, () => {});
          else afterEnter();
        } catch {
          /* user gesture / permission issue: nothing else to do */
        }
      };
      try {
        const p = request.call(el, { navigationUI: "hide" });
        if (p?.then) p.then(afterEnter, requestBare);
        else afterEnter();
      } catch {
        /* some browsers reject options — retry bare */
        requestBare();
      }
    };
    const ICON_ON =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 3H3v6M15 3h6v6M9 21H3v-6M15 21h6v-6"/></svg>';
    const ICON_OFF =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9h6V3M21 9h-6V3M3 15h6v6M21 15h-6v6"/></svg>';
    const sync = () => {
      const active = !!current();
      btn.classList.toggle("on", active);
      btn.innerHTML = active ? ICON_ON : ICON_OFF;
      btn.title = active ? "Exit fullscreen (G)" : "Fullscreen (G)";
      btn.setAttribute("aria-label", btn.title);
    };
    btn.onclick = () => this.toggleFullscreen();
    doc.addEventListener("fullscreenchange", sync);
    doc.addEventListener("webkitfullscreenchange", sync);
    sync();
  }

  // =========================================================================
  // Diwali firecracker economy: wallet / shop / inventory / quick bar
  // =========================================================================
  _wallet() {
    return (
      this.game.wallet || { balance: 0, inventory: {}, currency: CURRENCY }
    );
  }

  renderWallet() {
    const w = this._wallet();
    const bal = $("wallet-balance");
    const chip = $("wallet-chip");
    const text = String(w.balance ?? 0);
    if (bal) {
      if (
        this._lastBalance !== undefined &&
        this._lastBalance !== text &&
        chip
      ) {
        chip.classList.remove("pulse");
        void chip.offsetWidth;
        chip.classList.add("pulse");
      }
      bal.textContent = text;
      this._lastBalance = text;
    }
    if (chip)
      chip.title = `${w.balance ?? 0} ${CURRENCY.name} — free in-game currency, never real money`;
    this.renderQuickBar();
    if (this.current === "shop") this.renderShop();
    if (this.current === "inventory") this.renderInventory();
  }

  // ---- shop --------------------------------------------------------------
  openShop(it) {
    if (!it) return;
    const shop = SHOPS.find((s) => s.id === it.id);
    this.shopTitle.textContent = shop
      ? `${shop.sign}  ${COIN}`
      : `Firecracker Shop  ${COIN}`;
    this.shopCurrent = it.id;
    this.game.controller.setLocked(true);
    this.renderShop();
    this.show("shop");
  }

  closeShop() {
    if (this.current !== "shop") return;
    this.hideScreens();
    this.game.controller.setLocked(false);
  }

  setBuying(busy) {
    this.shopBusy = !!busy;
    if (!this.shopGrid) return;
    for (const b of this.shopGrid.querySelectorAll(".buy-btn")) {
      b.disabled = !!busy;
    }
    this.shopGrid.classList.toggle("busy", !!busy);
  }

  renderShop() {
    if (!this.shopGrid) return;
    const w = this._wallet();
    if (this.shopBalance) {
      this.shopBalance.textContent = "";
      this.shopBalance.append(
        el("span", "coin", COIN),
        el("b", "", String(w.balance ?? 0)),
        el("span", "muted", CURRENCY.name),
      );
    }
    this.shopGrid.textContent = "";
    for (const item of FIREWORKS)
      this.shopGrid.appendChild(this._shopCard(item, w));
    this.setBuying(this.game._buyPending);
  }

  _shopCard(item, w) {
    const card = el("div", "product-card");
    card.dataset.item = item.id;
    card.appendChild(el("div", "pc-icon", FX_EMOJI[item.icon] || "🎆"));

    const info = el("div", "pc-info");
    const nameRow = el("div", "pc-name");
    nameRow.append(el("b", "", item.name));
    if (item.alt) nameRow.appendChild(el("span", "pc-alt", item.alt));
    info.appendChild(nameRow);
    info.appendChild(el("div", "pc-tagline", item.tagline || ""));
    info.appendChild(el("div", "pc-desc", item.desc || ""));

    if (item.kind === "pack") {
      const contents = Object.entries(item.gives || {})
        .map(([gid, gq]) => `${gq}× ${fireworkById(gid)?.name || gid}`)
        .join(" · ");
      info.appendChild(el("div", "pc-owned", `Bundle: ${contents}`));
    } else {
      info.appendChild(
        el("div", "pc-owned", `In bag: ${w.inventory[item.id] || 0}`),
      );
    }
    card.appendChild(info);

    // price + quantity + buy
    const buy = el("div", "pc-buy");
    const price = el("div", "pc-price");
    price.append(el("span", "coin", COIN), el("b", "", String(item.price)));
    buy.appendChild(price);

    const qtyRow = el("div", "qty-pills");
    const qty = this.shopQty?.[item.id] || 1;
    for (const q of [1, 5, 9]) {
      const pill = el(
        "button",
        "qty-pill" + (q === qty ? " selected" : ""),
        "×" + q,
      );
      pill.onclick = () => {
        this.shopQty = { ...(this.shopQty || {}), [item.id]: q };
        this.renderShop();
      };
      qtyRow.appendChild(pill);
    }
    buy.appendChild(qtyRow);

    const cost = item.price * qty;
    const afford = cost <= (w.balance ?? 0);
    const b = el(
      "button",
      "btn small buy-btn" + (afford ? "" : " cant-afford"),
      `Buy ×${qty}`,
    );
    b.dataset.afford = afford ? "1" : "0";
    b.disabled = this.game._buyPending;
    b.title = afford
      ? `Costs ${cost} ${CURRENCY.name}`
      : `Not enough Diwali Coins (need ${cost})`;
    b.onclick = () => this.game.buy(item.id, qty);
    buy.appendChild(b);
    card.appendChild(buy);
    return card;
  }

  shakeShop() {
    const g = this.shopGrid;
    if (!g) return;
    g.classList.remove("shake");
    void g.offsetWidth; // restart the animation
    g.classList.add("shake");
  }

  // ---- inventory ---------------------------------------------------------
  openInventory() {
    if (!this.game.playing) return;
    this.game.controller.setLocked(true);
    this.renderInventory();
    this.show("inventory");
  }

  closeInventory() {
    if (this.current !== "inventory") return;
    this.hideScreens();
    this.game.controller.setLocked(false);
  }

  toggleInventory() {
    if (this.current === "inventory") this.closeInventory();
    else this.openInventory();
  }

  renderInventory() {
    if (!this.invBody) return;
    const w = this._wallet();
    if (this.invBalance) {
      this.invBalance.textContent = "";
      this.invBalance.append(
        el("span", "coin", COIN),
        el("b", "", String(w.balance ?? 0)),
        el("span", "muted", CURRENCY.name),
      );
    }
    this.invBody.textContent = "";
    const entries = FIREWORKS.filter(
      (f) => f.kind !== "pack" && (w.inventory[f.id] || 0) > 0,
    );
    if (!entries.length) {
      this.invBody.appendChild(
        el(
          "div",
          "inv-empty",
          "Your bag is empty. Visit DIWALI FIREWORKS or FESTIVAL CRACKERS on the south street to stock up.",
        ),
      );
      return;
    }
    for (const f of entries) {
      const equipped = this.game.equipped === f.id;
      const row = el("div", "inv-item" + (equipped ? " equipped" : ""));
      row.appendChild(el("span", "inv-emoji", FX_EMOJI[f.icon] || "🎆"));
      const info = el("div", "inv-info");
      const nm = el("div", "inv-name");
      nm.append(el("b", "", f.name));
      if (f.alt) nm.appendChild(el("span", "pc-alt", f.alt));
      info.append(nm, el("div", "pc-tagline", f.tagline || ""));
      row.appendChild(info);
      row.appendChild(el("span", "inv-qty", "×" + w.inventory[f.id]));
      const acts = el("div", "inv-actions");
      const equip = el(
        "button",
        "mini" + (equipped ? " on" : ""),
        equipped ? "Unequip" : "Equip",
      );
      equip.onclick = () =>
        equipped ? this.game.unequipItem() : this.game.equipItem(f.id);
      const use = el("button", "mini accent", "Use");
      use.onclick = () => this.game.useItem(f.id);
      acts.append(equip, use);
      row.appendChild(acts);
      this.invBody.appendChild(row);
    }
  }

  // ---- HUD quick-use bar -------------------------------------------------
  renderQuickBar() {
    const bar = $("fx-bar");
    if (!bar) return;
    const w = this._wallet();
    bar.textContent = "";
    const owned = FIREWORKS.filter(
      (f) => f.kind !== "pack" && (w.inventory[f.id] || 0) > 0,
    );
    if (!owned.length) {
      bar.hidden = true;
      return;
    }
    bar.hidden = false;
    for (const f of owned) {
      const equipped = this.game.equipped === f.id;
      const slot = el("button", "fx-slot" + (equipped ? " equipped" : ""));
      slot.title = `${f.name} — ${w.inventory[f.id]} left${equipped ? " (press F)" : ""}`;
      slot.appendChild(el("span", "fx-emoji", FX_EMOJI[f.icon] || "🎆"));
      slot.appendChild(el("span", "fx-count", String(w.inventory[f.id])));
      if (equipped) slot.appendChild(el("span", "fx-key", "F"));
      slot.onclick = () => this.game.equipItem(f.id);
      bar.appendChild(slot);
    }
    const bag = el("button", "fx-slot fx-bag", "🎒");
    bag.title = "Open inventory (I)";
    bag.onclick = () => this.openInventory();
    bar.appendChild(bag);
  }

  // ---- feedback ----------------------------------------------------------
  celebrate(text, detail = "") {
    const node = el("div", "fx-celebrate");
    node.appendChild(el("span", "fx-celebrate-icon", "🎆"));
    const t = el("div", "fx-celebrate-text");
    t.append(el("b", "", text));
    if (detail) t.appendChild(el("span", "", detail));
    node.appendChild(t);
    $("toasts").appendChild(node);
    setTimeout(() => node.remove(), 1900);
  }

  flashUse(name) {
    const node = el("div", "fx-use");
    node.append(el("span", "", "✨"), el("span", "", `Lit ${name}!`));
    $("toasts").appendChild(node);
    setTimeout(() => node.remove(), 1400);
  }

  // 3D avatar preview (character screen)
  _makePreview(stage) {
    const scene = new THREE.Scene();
    // keep the renderer transparent so the CSS gradient stage shows through
    scene.background = null;
    const cam = new THREE.PerspectiveCamera(38, 1, 0.1, 50);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    stage.appendChild(renderer.domElement);

    const key = new THREE.DirectionalLight(0xfff2dd, 2.5);
    const fill = new THREE.DirectionalLight(0xbcd6ff, 0.95);
    const rim = new THREE.DirectionalLight(0x8fe0ff, 1.2);
    scene.add(
      new THREE.AmbientLight(0xffffff, 0.3),
      new THREE.HemisphereLight(0xcfe0ff, 0x5a5468, 1.25),
      key,
      fill,
      rim,
    );

    // start on the buddy's front side at a 3/4 angle; the idle turntable
    // slowly cycles through every side anyway
    let rig = null,
      yaw = Math.PI + 0.5;
    const R = {
      dragging: false,
      setAvatar(av) {
        if (rig) {
          scene.remove(rig.root);
          rig.dispose?.();
        }
        rig = new CharacterRig(av, "", { noLabel: true });
        scene.add(rig.root);
      },
      orbit(dx) {
        yaw += dx * 0.01;
      },
      loop(t) {
        if (!R.dragging) yaw += 0.0032; // slow turntable while idle
        // studio lights ride with the viewer so the visible side is always lit
        key.position.set(
          Math.sin(yaw + 0.55) * 3,
          4.2,
          Math.cos(yaw + 0.55) * 3,
        );
        fill.position.set(
          Math.sin(yaw - 1.15) * 3,
          1.8,
          Math.cos(yaw - 1.15) * 3,
        );
        rim.position.set(
          Math.sin(yaw + Math.PI) * 3,
          3.2,
          Math.cos(yaw + Math.PI) * 3,
        );
        cam.position.set(Math.sin(yaw) * 3.5, 1.7, Math.cos(yaw) * 3.5);
        cam.lookAt(0, 1.02, 0);
        const w = stage.clientWidth,
          h = stage.clientHeight;
        if (
          renderer.domElement.width !== w ||
          renderer.domElement.height !== h
        ) {
          renderer.setSize(w, h, false);
          cam.aspect = w / h;
          cam.updateProjectionMatrix();
        }
        if (rig) rig.tick(1 / 60, 0, null, 0);
        renderer.render(scene, cam);
        void t;
      },
    };
    R.setAvatar(this.game.previewAv);
    this.previewLoop = (t) => R.loop(t);
    return R;
  }

  _renderPlayers() {
    const list = $("players-list");
    list.textContent = "";
    const g = this.game;
    const me = el("li");
    me.append(titleChip(g.name + " (you)", g.room));
    list.appendChild(me);
    for (const p of g.remotePlayers.values()) {
      const li = el("li");
      const name = el("div", "who");
      name.append(el("b", "", p.name), el("span", "", "nearby"));
      const chat = el("button", "mini", "");
      chat.textContent = "Chat";
      chat.onclick = () => startPm(this, p);
      const menu = el("button", "mini", "…");
      menu.onclick = (e) => this.playerMenu(e.clientX, e.clientY, p.id, p.name);
      li.append(name, chat, menu);
      list.appendChild(li);
    }
    if (!g.remotePlayers.size)
      list.appendChild(el("li", "muted", "Nobody around right now."));
  }

  _renderFriendsPanel() {
    const list = $("friends-list");
    list.textContent = "";
    if (!this.friendsCache?.length) {
      list.appendChild(el("li", "muted", "No friends yet — add someone!"));
      return;
    }
    for (const f of this.friendsCache) {
      const li = el("li");
      const who = el("div", "who");
      who.append(
        el("b", "", f.name),
        el("span", "", f.online ? f.room : "offline"),
      );
      const tag = el(
        "span",
        "tag" + (f.online ? "" : " off"),
        f.online ? "Online" : "Offline",
      );
      li.append(tag, who);
      if (f.online) {
        const go = el("button", "mini", "Go to");
        go.onclick = () => {
          this.game.net.send({ t: "joinRoom", name: f.name });
          closePanels();
        };
        li.appendChild(go);
      }
      const rm = el("button", "mini danger", "×");
      rm.onclick = () =>
        this.game.net.send({ t: "friend", op: "remove", name: f.name });
      li.appendChild(rm);
      list.appendChild(li);
    }
  }

  _renderVoicePanel() {
    const v = this.game.voice;
    const micBtn = $("voice-mic-btn");
    const muteBtn = $("voice-mic-mute");
    const listenBtn = $("voice-listen-btn");

    micBtn.textContent = v.enabled ? "Microphone: on" : "Enable microphone";
    muteBtn.textContent = v.micMuted ? "Unmute mic" : "Mute mic";
    muteBtn.disabled = !v.enabled;
    listenBtn.textContent = `Listen only: ${v.listening ? "on" : "off"}`;
    $("voice-vol").value = Math.round(v.speakerVolume * 100);

    const peers = [...v.peers.values()];
    const connected = peers.filter(
      (p) => p.pc.connectionState === "connected",
    ).length;
    let text;
    if (v.status === "insecure") {
      text =
        "Voice needs https:// or http://localhost — plain LAN http blocks the mic.";
    } else {
      text = `Proximity voice: ${v.status}`;
      if (v.listening) text += ` · ${connected}/${peers.length} peer(s)`;
      if (v.status === "denied" && v.lastError) text += ` — ${v.lastError}`;
    }
    $("voice-status").textContent = text;

    micBtn.onclick = async () => {
      if (!v.enabled) await v.enableMic();
      else v.disableMic();
      this._renderVoicePanel();
    };
    muteBtn.onclick = () => {
      v.toggleMic();
      this._renderVoicePanel();
    };
    listenBtn.onclick = () => {
      if (v.listening) v.stopListening();
      else v.startListening();
      this._renderVoicePanel();
    };
    $("voice-vol").oninput = () => {
      v.setSpeakerVolume(Number($("voice-vol").value) / 100);
    };
  }

  _renderFriendsScreen() {
    const list = this.friendsBody;
    list.textContent = "";
    if (!this.friendsCache?.length) {
      list.appendChild(el("li", "muted", "No friends yet."));
    }
    for (const f of this.friendsCache || []) {
      const li = el("li");
      const tag = el(
        "span",
        "tag" + (f.online ? "" : " off"),
        f.online ? "Online" : "Offline",
      );
      const who = el("div", "who");
      who.append(el("b", "", f.name), el("span", "", f.online ? f.room : ""));
      li.append(tag, who);
      if (f.online) {
        const go = el("button", "mini", "Join room");
        go.onclick = () => {
          this.game.net.send({ t: "joinRoom", name: f.name });
          this.hideScreens();
        };
        li.appendChild(go);
      }
      list.appendChild(li);
    }
  }

  _renderProfileScreen() {
    const g = this.game;
    const b = this.profileBody;
    b.textContent = "";
    const p = loadProfile();
    const stats = el("div", "stats");
    const st = (big, small) => {
      const d = el("div", "stat");
      d.append(el("b", "", big), el("span", "", small));
      return d;
    };
    stats.append(
      st(g.room || "—", "current room"),
      st(`${g.remotePlayers.size + 1}`, "players near"),
      st(`Not owned`, "house"),
    );
    b.append(
      el("h3", "", p.name || g.name),
      el(
        "p",
        "muted",
        `Device key: ${(localStorage.getItem("Diwali Meet Up.token") || "").slice(0, 8)}…`,
      ),
      stats,
    );
  }

  // =========================================================================
  // in-game interactions
  // =========================================================================
  setPrompt(item) {
    const p = $("interact-prompt");
    const useBtn = $("btn-use"); // touch equivalent of the E shortcut
    if (useBtn) useBtn.hidden = !item;
    if (!item) {
      p.hidden = true;
      return;
    }
    p.hidden = false;
    p.textContent = "";
    const kbd = el("kbd", "", "E");
    p.append(kbd, document.createTextNode(" " + item.label));
    p.onclick = () => this.game.controller.activate(item);
  }

  chatLine(m) {
    const log = $("chat-log");
    const div = el(
      "div",
      "chat-line" +
        (m.scope === "pm" ? " pm" : m.scope === "sys" ? " sys" : ""),
    );
    if (m.scope === "sys") div.textContent = m.text;
    else {
      const b = el("b", "", (m.self ? "(to) " : "") + `${m.name} · `);
      div.append(b, document.createTextNode(m.text));
      if (m.scope === "pm") div.classList.add("pm");
    }
    log.appendChild(div);
    while (log.children.length > 40) log.firstChild.remove();
    log.scrollTop = log.scrollHeight;
  }

  toast(text, actions = [], ms = 6000) {
    const t = el("div", "toast");
    t.appendChild(el("span", "", text));
    for (const [label, fn] of actions) {
      const b = el("button", "btn small", label);
      b.onclick = () => {
        fn();
        t.remove();
      };
      t.appendChild(b);
    }
    $("toasts").appendChild(t);
    setTimeout(() => t.remove(), ms);
  }

  acceptInvite(m) {
    if (m.freq) {
      // incoming friend request
      this.pendingInvites.set("freq:" + m.from, m);
      this.toast(
        `${m.name || m.fromName} sent a friend request`,
        [
          [
            "Add friend",
            () =>
              this.game.net.send({
                t: "friend",
                op: "accept",
                name: m.name || m.fromName,
              }),
          ],
          ["Ignore", () => {}],
        ],
        12000,
      );
      return;
    }
    this.pendingInvites.set(m.inviteId, m);
    this.toast(
      `${m.fromName} invited you to their house`,
      [
        [
          "Accept",
          () => this.game.net.send({ t: "inviteAccept", inviteId: m.inviteId }),
        ],
        ["Ignore", () => {}],
      ],
      12000,
    );
  }

  playerMenu(x, y, id, name) {
    const g = this.game;
    const menu = document.createElement("div");
    menu.id = "player-menu";
    menu.style.left = Math.min(innerWidth - 240, Math.max(8, x)) + "px";
    menu.style.top = Math.min(innerHeight - 240, Math.max(8, y)) + "px";
    const closeMenu = () => menu.remove();
    const add = (label, fn, cls) => {
      const b = el("button", "mini " + (cls || ""), label);
      b.onclick = () => {
        fn();
        closeMenu();
      };
      menu.appendChild(b);
    };
    add("Wave at them", () => {
      g.controller.playEmote("wave");
    });
    add("Send PM", () => startPm(this, { id, name }));
    add("Add friend", () => g.net.send({ t: "friend", op: "add", name }));
    if (this.game.myHouseId) {
      add("Invite to my house", () => g.net.send({ t: "invite", name }));
    }
    add("Mute their voice", () => {
      g.voice.block(id);
      toastInfo(this, "Voice muted");
    });
    add("Mute chat", () => {
      g.net.send({ t: "block", id, on: true });
      toastInfo(this, "Chat muted");
    });
    add(
      "Report",
      () => {
        g.net.send({ t: "report", id, reason: "user-reported" });
        toastInfo(this, "Report logged");
      },
      "danger",
    );
    const close = el("button", "mini", "Close");
    close.onclick = closeMenu;
    menu.appendChild(close);
    document.body.appendChild(menu);
    const kill = (e) => {
      if (!menu.contains(e.target)) {
        menu.remove();
        removeEventListener("mousedown", kill);
      }
    };
    setTimeout(() => addEventListener("mousedown", kill), 10);
  }

  setOwnedHouse(houseId) {
    this.game.myHouseId = houseId;
    this.toast(
      "You now own " + houseId.replace("house-", "House ") + "!",
      [],
      5000,
    );
  }

  setRoomLabel(room, type) {
    $("hud-room").textContent =
      type === "island" ? room.replace(/^island/, "village") : room;
  }

  connectedUi(state) {
    const dot = $("hud-dot");
    dot.style.background = state === "open" ? "#35d0c5" : "#e5484d";
    dot.style.boxShadow = `0 0 8px ${dot.style.background}`;
  }
}

// ---------------------------------------------------------------------------
function togglePanel(id) {
  const node = $(id);
  const was = !node.hidden;
  for (const k of ["players-panel", "friends-panel", "voice-panel"])
    $(k).hidden = true;
  node.hidden = was;
}
function closePanels(except) {
  for (const k of ["players-panel", "friends-panel", "voice-panel"]) {
    if (k !== except) $(k).hidden = true;
  }
}
function startPm(ui, p) {
  ui.pmTo = { id: p.id, name: p.name };
  const input = $("chat-input");
  input.placeholder = `To ${p.name} (Esc cancels):`;
  input.focus();
  closePanels();
}
function toastInfo(ui, text) {
  ui.toast(text, [], 3000);
}
function titleChip(name, room) {
  const who = el("div", "who");
  who.append(el("b", "", name), el("span", "", room));
  who.style.flex = "1";
  return who;
}

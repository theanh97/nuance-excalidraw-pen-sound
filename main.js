const { Plugin, PluginSettingTab, Setting, Notice } = require("obsidian");

const DEFAULT_SETTINGS = {
  enabled: true,
  volume: 0.20,
  tone: 0.5,    // 0 = warm/soft, 1 = bright/gritty
  dockEnabled: true,
  dockPosition: null,  // { x, y } — null = use CSS default
};

module.exports = class ExcalidrawPenSoundPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.audio = null;
    this.isDrawing = false;
    this.lastEvent = null;
    this.lastGrainAt = 0;
    this.statusBarEl = null;
    this.popupEl = null;
    this.spaceHeld = false;          // spacebar = Excalidraw pan mode
    this.dockDragState = null;       // { startX, startY, startLeft, startTop }
    this.dockObserver = null;

    this.addSettingTab(new PenSoundSettingTab(this.app, this));
    this.createStatusBar();

    this.addCommand({
      id: "toggle-pen-sound",
      name: "Toggle pen sound on/off",
      callback: () => this.toggleSound(),
    });

    this.addCommand({
      id: "toggle-pen-dock",
      name: "Toggle pen/highlighter dock",
      callback: () => this.toggleDock(),
    });

    this.addCommand({
      id: "reset-pen-dock",
      name: "Reset pen dock position",
      callback: () => this.resetDockPosition(),
    });

    // ── Pointer events for sound ──
    this.registerDomEvent(document, "pointerdown", (e) => this.onPointerDown(e), true);
    this.registerDomEvent(document, "pointermove", (e) => this.onPointerMove(e), true);
    this.registerDomEvent(document, "pointerup", () => this.onPointerUp(), true);
    this.registerDomEvent(document, "pointercancel", () => this.onPointerUp(), true);
    this.registerDomEvent(window, "blur", () => {
      this.spaceHeld = false;
      this.onPointerUp();
    });

    // ── Space + K key tracking (Excalidraw scoped) ──
    this.registerDomEvent(window, "keydown", (e) => {
      if (e.code === "Space" && !this.isEditableTarget(e.target)) {
        this.spaceHeld = true;
      }
      // K = lasso select — ONLY when Excalidraw is the active view and not in a text field
      if (
        e.code === "KeyK" &&
        !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey &&
        !this.isEditableTarget(e.target) &&
        this.isExcalidrawViewActive()
      ) {
        e.preventDefault();
        e.stopPropagation();
        this.activateLassoTool();
      }
    });
    this.registerDomEvent(window, "keyup", (e) => {
      if (e.code === "Space") this.spaceHeld = false;
    });

    // Close popup on click outside
    this.registerDomEvent(document, "pointerdown", (e) => {
      if (this.popupEl && !this.popupEl.contains(e.target) && !this.statusBarEl.contains(e.target)) {
        this.closePopup();
      }
    });

    // ── Drag support for existing Excalidraw pen toolbar ──
    this.app.workspace.onLayoutReady(() => {
      this.setupDockObserver();
      this.attachDockToAll();
    });
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.attachDockToAll()));
  }

  onunload() {
    this.onPointerUp();
    this.closePopup();
    if (this.dockObserver) {
      this.dockObserver.disconnect();
      this.dockObserver = null;
    }
    if (this.audio?.ctx?.state !== "closed") {
      this.audio?.ctx?.close().catch(() => {});
    }
    this.audio = null;
  }

  // ── Status bar UI ──

  createStatusBar() {
    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass("pen-sound-status");
    this.statusBarEl.style.cursor = "pointer";
    this.statusBarEl.style.userSelect = "none";
    this.statusBarEl.addEventListener("click", (e) => {
      e.stopPropagation();
      this.togglePopup();
    });
    this.updateStatusBar();
  }

  updateStatusBar() {
    if (!this.statusBarEl) return;
    const vol = Math.round(this.settings.volume * 100);
    const icon = !this.settings.enabled ? "\u{1F507}" : vol > 50 ? "\u{1F50A}" : vol > 0 ? "\u{1F509}" : "\u{1F508}";
    this.statusBarEl.setText(`${icon} Pen ${this.settings.enabled ? vol + "%" : "OFF"}`);
  }

  togglePopup() {
    if (this.popupEl) {
      this.closePopup();
      return;
    }

    this.popupEl = document.createElement("div");
    const popup = this.popupEl;
    Object.assign(popup.style, {
      position: "fixed",
      bottom: "32px",
      right: "12px",
      background: "var(--background-secondary)",
      border: "1px solid var(--background-modifier-border)",
      borderRadius: "8px",
      padding: "12px 16px",
      zIndex: "9999",
      boxShadow: "0 4px 16px rgba(0,0,0,0.2)",
      minWidth: "220px",
      fontFamily: "var(--font-interface)",
      fontSize: "13px",
    });

    const title = popup.createEl("div", { text: "Pen Sound" });
    Object.assign(title.style, {
      fontWeight: "600", marginBottom: "10px", fontSize: "14px",
      color: "var(--text-normal)",
    });

    const toggleRow = popup.createEl("div");
    Object.assign(toggleRow.style, { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" });
    toggleRow.createEl("span", { text: "Enabled" }).style.color = "var(--text-muted)";
    const toggleBtn = toggleRow.createEl("div");
    Object.assign(toggleBtn.style, {
      width: "36px", height: "20px", borderRadius: "10px", cursor: "pointer", position: "relative", transition: "background 0.2s",
      background: this.settings.enabled ? "var(--interactive-accent)" : "var(--background-modifier-border)",
    });
    const toggleDot = toggleBtn.createEl("div");
    Object.assign(toggleDot.style, {
      width: "16px", height: "16px", borderRadius: "50%", background: "white", position: "absolute", top: "2px", transition: "left 0.2s",
      left: this.settings.enabled ? "18px" : "2px",
    });
    toggleBtn.addEventListener("click", async () => {
      await this.toggleSound();
      toggleBtn.style.background = this.settings.enabled ? "var(--interactive-accent)" : "var(--background-modifier-border)";
      toggleDot.style.left = this.settings.enabled ? "18px" : "2px";
    });

    this.addSliderRow(popup, "Volume", this.settings.volume, async (v) => {
      this.settings.volume = v;
      await this.saveData(this.settings);
      this.updateStatusBar();
    });

    this.addSliderRow(popup, "Tone", this.settings.tone, async (v) => {
      this.settings.tone = v;
      await this.saveData(this.settings);
    }, "Soft", "Bright");

    const testBtn = popup.createEl("button", { text: "Test" });
    Object.assign(testBtn.style, {
      marginTop: "8px", width: "100%", padding: "6px", cursor: "pointer",
      borderRadius: "4px", border: "1px solid var(--background-modifier-border)",
      background: "var(--background-primary)", color: "var(--text-normal)",
      fontSize: "12px",
    });
    testBtn.addEventListener("click", () => {
      this.ensureAudio();
      for (let i = 0; i < 12; i++) {
        setTimeout(() => this.playGrain(0.3 + Math.random() * 0.4, 0.5), i * 35);
      }
    });

    document.body.appendChild(popup);
  }

  addSliderRow(parent, label, value, onChange, minLabel, maxLabel) {
    const row = parent.createEl("div");
    Object.assign(row.style, { marginBottom: "8px" });

    const header = row.createEl("div");
    Object.assign(header.style, { display: "flex", justifyContent: "space-between", marginBottom: "4px" });
    header.createEl("span", { text: label }).style.color = "var(--text-muted)";
    const valDisplay = header.createEl("span", { text: Math.round(value * 100) + "%" });
    valDisplay.style.color = "var(--text-faint)";

    if (minLabel) {
      const labels = row.createEl("div");
      Object.assign(labels.style, { display: "flex", justifyContent: "space-between", fontSize: "10px", color: "var(--text-faint)", marginBottom: "2px" });
      labels.createEl("span", { text: minLabel });
      labels.createEl("span", { text: maxLabel });
    }

    const slider = row.createEl("input");
    slider.type = "range";
    slider.min = "0";
    slider.max = "100";
    slider.value = String(Math.round(value * 100));
    Object.assign(slider.style, { width: "100%", accentColor: "var(--interactive-accent)" });

    slider.addEventListener("input", async () => {
      const v = parseInt(slider.value) / 100;
      valDisplay.setText(Math.round(v * 100) + "%");
      await onChange(v);
    });
  }

  closePopup() {
    if (this.popupEl) {
      this.popupEl.remove();
      this.popupEl = null;
    }
  }

  async toggleSound() {
    this.settings.enabled = !this.settings.enabled;
    await this.saveData(this.settings);
    this.updateStatusBar();
  }

  // ── Pointer handlers ──

  onPointerDown(event) {
    if (!this.settings.enabled || !this.isOnExcalidrawCanvas(event)) return;
    if (event.pointerType === "touch") return;    // finger = pan on mobile
    if (this.spaceHeld) return;                   // space+drag = pan on desktop

    // Tool check: only block when API is available AND tells us it's NOT freedraw.
    // If the API is unavailable (returns null), allow — canvas+space checks are enough.
    const api = this.getExcalidrawAPI();
    if (api) {
      try {
        const st = api.getAppState();
        if (st && st.activeTool && st.activeTool.type !== "freedraw") return;
      } catch (e) {}
    }

    this.isDrawing = true;
    this.lastEvent = event;
    this.ensureAudio();
  }

  onPointerMove(event) {
    if (!this.isDrawing || !this.settings.enabled) return;
    if (!this.isOnExcalidrawCanvas(event)) return;
    if (event.pointerType === "touch" || this.spaceHeld) {
      this.onPointerUp();
      return;
    }

    const prev = this.lastEvent || event;
    const dx = event.clientX - prev.clientX;
    const dy = event.clientY - prev.clientY;
    const dist = Math.hypot(dx, dy);
    this.lastEvent = event;

    if (dist < 1.2) return;

    const now = performance.now();
    const elapsed = now - this.lastGrainAt;
    const interval = Math.max(16, 30 - dist * 0.6);
    if (elapsed < interval) return;

    this.lastGrainAt = now;
    const speed = Math.min(dist / 22, 1);
    const pressure = event.pressure > 0 ? event.pressure : 0.5;
    this.playGrain(speed, pressure);
  }

  onPointerUp() {
    this.isDrawing = false;
    this.lastEvent = null;
  }

  isOnExcalidrawCanvas(event) {
    const t = event.target;
    if (!t || !(t instanceof Element)) return false;
    if (t.closest(".App-toolbar, .App-menu, .excalidraw-ui-top-right, .selected-shape-actions")) return false;
    return Boolean(t.closest(".excalidraw") && t.closest(".excalidraw__canvas, canvas"));
  }

  isEditableTarget(t) {
    if (!t) return false;
    const tag = (t.tagName || "").toUpperCase();
    if (tag === "INPUT" || tag === "TEXTAREA" || t.isContentEditable) return true;
    if (t.closest && t.closest(".cm-editor, input, textarea, [contenteditable]")) return true;
    return false;
  }

  isFreedrawActive() {
    // Try JS API first (most accurate)
    try {
      const api = this.getExcalidrawAPI();
      if (api) {
        const st = api.getAppState();
        if (st && st.activeTool) return st.activeTool.type === "freedraw";
      }
    } catch (e) {}

    // DOM fallback — works even when JS API is unavailable
    // Excalidraw marks the active toolbar button with aria-pressed="true"
    const pencilBtn = document.querySelector(
      '.excalidraw button[data-testid="toolbar-freedraw"][aria-pressed="true"],' +
      '.excalidraw .ToolIcon[aria-label*="raw"][aria-pressed="true"],' +
      '.excalidraw .App-toolbar button.active[aria-label*="raw"],' +
      '.excalidraw .App-toolbar [class*="freedraw"][class*="active"]'
    );
    if (pencilBtn) return true;

    // If API is completely unavailable, allow sound — isOnExcalidrawCanvas() still gates us.
    // This avoids total silence when Excalidraw exposes its API differently.
    const api = this.getExcalidrawAPI();
    return api === null;
  }

  isExcalidrawViewActive() {
    const leaf = this.app.workspace.activeLeaf;
    return leaf && leaf.view && typeof leaf.view.getViewType === "function" &&
           leaf.view.getViewType() === "excalidraw";
  }

  activateLassoTool() {
    const api = this.getExcalidrawAPI();
    if (!api) return;
    try {
      api.setActiveTool({ type: "lasso" });
    } catch (e) {
      try { api.setActiveTool({ type: "selection" }); } catch (_) {}
    }
  }

  getExcalidrawAPI() {
    // Prefer the active leaf
    const active = this.app.workspace.activeLeaf;
    if (active && active.view && typeof active.view.getViewType === "function" &&
        active.view.getViewType() === "excalidraw" && active.view.excalidrawAPI) {
      return active.view.excalidrawAPI;
    }
    // Fall back to any open Excalidraw leaf
    const leaves = this.app.workspace.getLeavesOfType("excalidraw");
    for (const leaf of leaves) {
      if (leaf.view && leaf.view.excalidrawAPI) return leaf.view.excalidrawAPI;
    }
    return null;
  }

  // ── Dock (drag support for the existing Excalidraw pen toolbar) ──

  setupDockObserver() {
    if (this.dockObserver) return;
    this.dockObserver = new MutationObserver(() => this.attachDockToAll());
    this.dockObserver.observe(document.body, { childList: true, subtree: true });
  }

  attachDockToAll() {
    // Try the user's CSS-targeted selector first, fall back to common Excalidraw variants
    const selectors = [
      ".excalidraw .excalidraw-ui-top-right.library-and-pen",
      ".excalidraw .excalidraw-ui-top-right",
      ".excalidraw .App-toolbar--top-right",
    ];
    let attached = false;
    for (const sel of selectors) {
      const found = document.querySelectorAll(sel);
      if (found.length) {
        found.forEach((tb) => this.attachDock(tb));
        attached = true;
      }
    }
    this.applyDockVisibility();
    // Update status bar hint so user can see dock status
    if (this.statusBarEl) {
      this.statusBarEl.title = attached
        ? "Pen sound • drag empty area of pen dock to reposition"
        : "Pen sound • (no pen dock found — make sure Excalidraw is open)";
    }
  }

  applyDockPosition(toolbar, x, y) {
    // Use !important on inline style to override the CSS rules in
    // excalidraw-highlighter-toolbar.css which also use !important.
    toolbar.style.setProperty("left", x + "px", "important");
    toolbar.style.setProperty("top", y + "px", "important");
    toolbar.style.setProperty("right", "auto", "important");
    toolbar.style.setProperty("bottom", "auto", "important");
    toolbar.style.setProperty("transform", "none", "important");
  }

  attachDock(toolbar) {
    if (!toolbar || toolbar.dataset.dockAttached === "true") return;
    toolbar.dataset.dockAttached = "true";

    // Visual hint — only set on the toolbar background, not on inner buttons
    toolbar.style.cursor = "grab";
    toolbar.title = "Drag empty area to reposition • click a tool to select it";

    // Apply saved position (uses !important to beat existing CSS)
    if (this.settings.dockPosition) {
      this.applyDockPosition(toolbar, this.settings.dockPosition.x, this.settings.dockPosition.y);
    }

    const onPointerDown = (e) => {
      // Don't start a drag if the user clicked on a tool button, color swatch, or label
      if (e.target.closest(".ToolIcon, .color-picker-content, label, button, input, select, svg, path")) return;
      if (e.button !== 0) return; // only left-click / single touch
      e.preventDefault();
      e.stopPropagation();

      const rect = toolbar.getBoundingClientRect();
      this.dockDragState = {
        toolbar,
        startX: e.clientX,
        startY: e.clientY,
        startLeft: rect.left,
        startTop: rect.top,
      };
      toolbar.style.cursor = "grabbing";
    };

    // Listen on document for move/up so drag continues when pointer leaves the toolbar.
    // setPointerCapture alone is unreliable inside Excalidraw's React event handlers.
    const onDocMove = (e) => {
      if (!this.dockDragState) return;
      const dx = e.clientX - this.dockDragState.startX;
      const dy = e.clientY - this.dockDragState.startY;
      const newLeft = this.dockDragState.startLeft + dx;
      const newTop = this.dockDragState.startTop + dy;
      this.applyDockPosition(this.dockDragState.toolbar, newLeft, newTop);
    };

    const onDocUp = () => {
      if (!this.dockDragState) return;
      const rect = this.dockDragState.toolbar.getBoundingClientRect();
      this.settings.dockPosition = { x: rect.left, y: rect.top };
      this.saveData(this.settings);
      this.dockDragState.toolbar.style.cursor = "grab";
      this.dockDragState = null;
    };

    toolbar.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("pointermove", onDocMove, true);
    document.addEventListener("pointerup", onDocUp, true);
    document.addEventListener("pointercancel", onDocUp, true);
  }

  applyDockVisibility() {
    const toolbars = document.querySelectorAll(
      ".excalidraw .excalidraw-ui-top-right.library-and-pen, .excalidraw .excalidraw-ui-top-right, .excalidraw .App-toolbar--top-right"
    );
    toolbars.forEach((tb) => {
      if (!this.settings.dockEnabled) {
        tb.style.setProperty("display", "none", "important");
      } else {
        tb.style.removeProperty("display");
      }
    });
  }

  async toggleDock() {
    this.settings.dockEnabled = !this.settings.dockEnabled;
    await this.saveData(this.settings);
    this.applyDockVisibility();
    new Notice(this.settings.dockEnabled ? "Pen dock shown" : "Pen dock hidden");
  }

  async resetDockPosition() {
    this.settings.dockPosition = null;
    await this.saveData(this.settings);
    const toolbars = document.querySelectorAll(".excalidraw .excalidraw-ui-top-right.library-and-pen");
    toolbars.forEach((tb) => {
      tb.style.removeProperty("left");
      tb.style.removeProperty("top");
      tb.style.removeProperty("right");
      tb.style.removeProperty("bottom");
      tb.style.removeProperty("transform");
    });
    new Notice("Pen dock position reset");
  }

  // ── Audio engine ──

  ensureAudio() {
    if (this.audio) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;

    const ctx = new AC();
    const sr = ctx.sampleRate;

    const len = Math.round(sr * 0.15);
    const buf = ctx.createBuffer(1, len, sr);
    const ch = buf.getChannelData(0);

    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.96900 * b2 + white * 0.1538520;
      b3 = 0.86650 * b3 + white * 0.3104856;
      b4 = 0.55000 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.0168980;
      const pink = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.5;
      b6 = white * 0.115926;

      const t = i / len;
      const env = 0.5 * (1 - Math.cos(2 * Math.PI * t));
      ch[i] = pink * env;
    }

    const master = ctx.createGain();
    master.gain.value = 1;
    master.connect(ctx.destination);

    this.audio = { ctx, buf, master };
  }

  playGrain(speed, pressure) {
    if (!this.audio) return;
    const { ctx, buf, master } = this.audio;
    if (ctx.state === "suspended") ctx.resume().catch(() => {});

    const now = ctx.currentTime;
    const vol = Math.max(0, Math.min(this.settings.volume, 1));
    const tone = this.settings.tone;

    // Pressure: mouse always returns 0 → normalize to 0.5 so desktop still sounds good.
    // Stylus on tablet returns 0–1 with real pressure.
    const p = pressure > 0 ? pressure : 0.5;

    // Intensity: pressure now has much higher weight (0.45 vs old 0.25)
    // so light touch = quiet/soft, heavy press = loud/crunchy
    const intensity = 0.1 + speed * 0.45 + p * 0.45;

    const src = ctx.createBufferSource();
    src.buffer = buf;
    // Pressure also shifts pitch — heavy press sounds more "gritty"
    src.playbackRate.value = 0.65 + Math.random() * 0.25 + speed * 0.2 + p * 0.2;

    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    // Heavy pressure opens up more highs (brighter, more scrape)
    lp.frequency.value = 600 + tone * 2000 + speed * 600 + p * 600 + Math.random() * 200;
    lp.Q.value = 0.4;

    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 80 + tone * 120;
    hp.Q.value = 0.3;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(vol * intensity, now + 0.015);
    gain.gain.setValueAtTime(vol * intensity, now + 0.06);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.14);

    src.connect(hp).connect(lp).connect(gain).connect(master);
    src.start(now);
    src.stop(now + 0.15);
  }
};

// ── Settings Tab ──

class PenSoundSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Excalidraw Pen Sound" });

    new Setting(containerEl)
      .setName("Enable pen sound")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.enabled).onChange(async (v) => {
          this.plugin.settings.enabled = v;
          await this.plugin.saveData(this.plugin.settings);
          this.plugin.updateStatusBar();
        })
      );

    new Setting(containerEl)
      .setName("Volume")
      .setDesc("0–100%")
      .addSlider((s) =>
        s.setLimits(0, 100, 5)
          .setValue(Math.round(this.plugin.settings.volume * 100))
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.volume = v / 100;
            await this.plugin.saveData(this.plugin.settings);
            this.plugin.updateStatusBar();
          })
      );

    new Setting(containerEl)
      .setName("Tone")
      .setDesc("Soft (warm) ← → Bright (gritty)")
      .addSlider((s) =>
        s.setLimits(0, 100, 5)
          .setValue(Math.round(this.plugin.settings.tone * 100))
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.tone = v / 100;
            await this.plugin.saveData(this.plugin.settings);
          })
      );

    containerEl.createEl("h3", { text: "Pen / Highlighter Dock" });

    new Setting(containerEl)
      .setName("Show dock")
      .setDesc("Show the floating pen/highlighter toolbar in Excalidraw")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.dockEnabled).onChange(async (v) => {
          this.plugin.settings.dockEnabled = v;
          await this.plugin.saveData(this.plugin.settings);
          this.plugin.applyDockVisibility();
        })
      );

    new Setting(containerEl)
      .setName("Reset dock position")
      .setDesc("Drag the empty area of the dock to reposition. Use this to revert to default.")
      .addButton((b) =>
        b.setButtonText("Reset").onClick(async () => {
          await this.plugin.resetDockPosition();
        })
      );
  }
}

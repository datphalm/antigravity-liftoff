/**
 * Antigravity Launcher v3 — điều khiển
 *
 * Kịch bản: một đường sàn được kẻ ra → chữ ANTIGRAVITY rơi xuống, nảy, nằm yên
 * → người dùng nạp phản trọng lực (giữ Space / chuột, gõ PIN, hoặc tự động)
 * → cất cánh: hút gió, nổ, mọi thứ bay ngược lên → logo lơ lửng → mở app.
 *
 * Cầu Python (launcher.py) giữ nguyên: get_bootstrap, get_live_stats,
 * update_config, launch_antigravity, complete_and_exit, exit_now.
 */
(() => {
  "use strict";

  const THEMES = {
    "silver-ink": {
      name: "Mực bạc",
      bg: "#050506",
      ground: "#0b0c0f",
      ink: "#f8fafc",
      accent: "#ffffff",
      trail: "#94a3b8",
      sheen: [
        [0, "#ffffff"],
        [0.5, "#eef2f7"],
        [0.5, "#c3cbd6"],
        [1, "#9aa5b4"],
      ],
      art: "assets/art/silver_ink.webp",
      artVideo: "assets/art/silver_ink.mp4",
      artIdle: 0.13,
    },
    "crimson-singularity": { name: "Đỏ", bg: "#0b0708", ground: "#140d0e", ink: "#f4efe9", accent: "#ff3b2f" },
    "obsidian-prism": { name: "Xanh", bg: "#07080b", ground: "#0e1016", ink: "#eef1f6", accent: "#4b83ff" },
    "quantum-cyber": { name: "Cyan", bg: "#05080a", ground: "#0a1114", ink: "#e9f6f8", accent: "#18dcff" },
    "solar-eclipse": { name: "Hổ phách", bg: "#0b0906", ground: "#15110a", ink: "#f6efe2", accent: "#ffb21a" },
    "emerald-matrix": { name: "Lục", bg: "#060a07", ground: "#0c130e", ink: "#eaf3ec", accent: "#2bf08a" },
    "paper-white": { name: "Giấy", bg: "#ece9e2", ground: "#e1ddd4", ink: "#121212", accent: "#ff3b2f" },
  };
  const THEME_ORDER = Object.keys(THEMES);
  const TARGET_ORDER = ["antigravity", "antigravity_ide", "antigravity_tools"];
  const TARGET_DEFAULTS = {
    antigravity: { label: "Antigravity" },
    antigravity_ide: { label: "Antigravity IDE" },
    antigravity_tools: { label: "Antigravity Tools" },
  };
  const DEFAULT_THEME = "silver-ink";
  const HOLD_SECONDS = 1.05;
  const AUTO_DELAY_DEFAULT = 4;
  const AUTO_CHARGE_SECONDS = 0.85;
  const UI_HOVER_SELECTOR = ".t-row, .w-row, .hold-btn, .key-btn, .digit-row button, .action-auto-zone";
  const SPARK = "▁▂▃▄▅▆▇█";

  const $ = (id) => document.getElementById(id);
  const body = document.body;
  const root = document.documentElement;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const state = {
    phase: "boot", // boot | drop | ready | liftoff | exit
    config: {
      target: "antigravity",
      targets: {},
      theme: DEFAULT_THEME,
      voice: "en",
      auth_mode: "biometric",
      auto_delay: AUTO_DELAY_DEFAULT,
      pin_code: "2026",
      operator_name: "",
      volume: 0.85,
      muted: false,
      ambient_pulse: true,
    },
    telemetry: {
      operator: "OPERATOR",
      hostname: "LOCAL",
      os: "WIN",
      ag_version: "",
      targets: {},
      workspaces: [],
      stats: null,
    },
    bridge: false,
    charge: 0,
    holding: false,
    holdSources: new Set(),
    spaceDown: false,
    pinBuffer: "",
    autoActive: false,
    autoCharging: false,
    autoLeft: AUTO_DELAY_DEFAULT,
    hoverUI: false,
    modeOverride: null,
    settingsOpen: false,
    selectedWorkspace: null,
    cpuHistory: [],
    launchError: null,
    timers: [],
    lastTheme: null,
    lastPct: -1,
    lastSecond: -1,
  };

  const audio = new window.AntigravityAudioEngine();
  const stage = new window.GravityStage($("stage-canvas"));

  // ------------------------------------------------------------- helpers
  function schedule(fn, ms) {
    const id = setTimeout(fn, ms);
    state.timers.push(id);
    return id;
  }

  function clearTimers() {
    state.timers.forEach(clearTimeout);
    state.timers = [];
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function bridgeReady() {
    return Boolean(window.pywebview && window.pywebview.api && typeof window.pywebview.api.get_bootstrap === "function");
  }

  async function callPython(method, ...args) {
    try {
      if (window.pywebview && window.pywebview.api && typeof window.pywebview.api[method] === "function") {
        return await window.pywebview.api[method](...args);
      }
    } catch (err) {
      console.warn("[launcher] python error:", method, err);
    }
    return null;
  }

  function waitForBridge(timeout) {
    return new Promise((resolve) => {
      if (bridgeReady()) return resolve(true);
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        resolve(v);
      };
      window.addEventListener("pywebviewready", () => finish(true), { once: true });
      setTimeout(() => finish(bridgeReady()), timeout);
    });
  }

  function targetInfo(key) {
    const t = (state.telemetry.targets && state.telemetry.targets[key]) || {};
    const c = (state.config.targets && state.config.targets[key]) || {};
    return {
      label: t.label || c.label || (TARGET_DEFAULTS[key] || {}).label || key,
      path: t.path || c.path || "",
      exists: t.exists,
    };
  }

  function targetLabel() {
    return targetInfo(state.config.target).label;
  }

  function effectiveMode() {
    const m = state.modeOverride || state.config.auth_mode;
    return m === "pin" || m === "auto" ? m : "biometric";
  }

  function autoDelay() {
    const v = Number(state.config.auto_delay);
    return v >= 1 && v <= 15 ? v : AUTO_DELAY_DEFAULT;
  }

  /** Đếm ngược dừng lại khi đang rê chuột lên một lựa chọn hoặc mở cài đặt */
  function autoPaused() {
    return state.settingsOpen || state.hoverUI;
  }

  /** Vừa chọn app / thư mục khác: nới thêm thời gian thay vì huỷ chế độ tự động */
  function bumpAuto() {
    if (!state.autoActive) return;
    if (state.autoCharging) {
      state.autoCharging = false;
      state.charge = Math.min(state.charge, 0.2);
    }
    state.autoLeft = Math.max(state.autoLeft, Math.min(autoDelay(), 2.5));
  }

  // ------------------------------------------------------- UI gravity vars
  function assignFallVars() {
    const items = [...document.querySelectorAll("[data-fall]")].map((n) => ({ n, r: n.getBoundingClientRect() }));
    items.sort((a, b) => a.r.top - b.r.top || a.r.left - b.r.left);
    const half = window.innerWidth / 2;
    items.forEach(({ n, r }, idx) => {
      n.style.setProperty("--i", String(idx));
      const dist = Math.abs(r.left + r.width / 2 - half) / half;
      n.style.setProperty("--j", String(Math.round(dist * 150 + Math.random() * 90)));
      n.style.setProperty("--rot", `${((Math.random() * 2 - 1) * 24).toFixed(1)}deg`);
    });
  }

  // ------------------------------------------------------------ rendering
  function buildTargets() {
    const list = $("target-list");
    list.innerHTML = "";
    TARGET_ORDER.forEach((key, idx) => {
      const b = el("button", "t-row");
      b.dataset.target = key;
      b.setAttribute("data-fall", "");
      const meta = el("span", "t-meta");
      meta.append(el("span", "t-status"), el("kbd", "t-key", String(idx + 1)));
      b.append(el("span", "t-mark"), el("span", "t-name", targetInfo(key).label), meta);
      b.addEventListener("mouseenter", () => audio.hover());
      b.addEventListener("click", () => selectTarget(key));
      list.appendChild(b);
    });
    syncTargets();
  }

  function syncTargets() {
    const pin = effectiveMode() === "pin";
    document.querySelectorAll(".t-row").forEach((b) => {
      const key = b.dataset.target;
      const info = targetInfo(key);
      b.classList.toggle("active", key === state.config.target);
      b.classList.toggle("missing", info.exists === false);
      b.title = info.exists === false ? `Không tìm thấy: ${info.path}` : info.path;
      b.querySelector(".t-name").textContent = info.label;
      b.querySelector(".t-status").textContent = info.exists === false ? "chưa cài" : "";
      b.querySelector(".t-key").classList.toggle("hidden", pin);
    });
  }

  function buildWorkspaces() {
    const list = $("ws-list");
    list.innerHTML = "";
    const items = (state.telemetry.workspaces || []).slice(0, 4);
    if (!items.length) {
      const d = el("div", "w-empty", "Không thấy thư mục nào trên Desktop");
      d.setAttribute("data-fall", "");
      list.appendChild(d);
      return;
    }
    items.forEach((ws) => {
      const b = el("button", "w-row");
      b.setAttribute("data-fall", "");
      b.dataset.path = ws.path;
      b.title = ws.path;
      b.append(el("span", "w-name", ws.name), el("span", "w-tag", "mở"));
      b.addEventListener("mouseenter", () => audio.hover());
      b.addEventListener("click", () => {
        audio.click();
        if (state.selectedWorkspace && state.selectedWorkspace.path === ws.path) {
          state.selectedWorkspace = null;
        } else {
          state.selectedWorkspace = ws;
          if (state.config.target !== "antigravity_ide") selectTarget("antigravity_ide");
        }
        bumpAuto();
        syncWorkspaces();
        syncAction();
      });
      list.appendChild(b);
    });
    syncWorkspaces();
  }

  function syncWorkspaces() {
    const sel = state.selectedWorkspace && state.selectedWorkspace.path;
    document.querySelectorAll(".w-row").forEach((b) => {
      const on = b.dataset.path === sel;
      b.classList.toggle("active", on);
      b.querySelector(".w-tag").textContent = on ? "đã chọn" : "mở";
    });
  }

  function buildDigits() {
    const row = $("digit-row");
    row.innerHTML = "";
    ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0", "back"].forEach((k) => {
      const b = el("button", null, k === "back" ? "⌫" : k);
      b.addEventListener("click", () => pinKey(k));
      row.appendChild(b);
    });
  }

  function actionView() {
    const m = effectiveMode();
    return m === "auto" ? "auto" : m === "pin" ? "pin" : "hold";
  }

  function syncAction() {
    const view = actionView();
    $("action-hold").classList.toggle("hidden", view !== "hold");
    $("action-pin").classList.toggle("hidden", view !== "pin");
    $("action-auto").classList.toggle("hidden", view !== "auto");
    $("action-label").textContent = view === "pin" ? "Mở khoá" : view === "auto" ? "Tự động" : "Cất cánh";
    const ws = state.selectedWorkspace;
    $("auto-target").textContent = ws ? `${targetLabel()} · ${ws.name}` : targetLabel();
    syncPin();
  }

  function syncPin() {
    const cells = $("pin-row").children;
    for (let i = 0; i < cells.length; i++) cells[i].classList.toggle("on", i < state.pinBuffer.length);
  }

  function renderStats(s) {
    if (!s) return;
    const cpu = clamp(Math.round(Number(s.cpu_pct) || 0), 0, 100);
    state.cpuHistory.push(cpu);
    if (state.cpuHistory.length > 10) state.cpuHistory.shift();
    const spark = state.cpuHistory.map((v) => SPARK[Math.min(7, Math.floor(v / 12.5))]).join("");
    $("tb-cpu-spark").textContent = spark.padStart(10, "▁");
    $("tb-cpu").textContent = `${cpu}%`;
    $("tb-ram").textContent = `${s.ram_used_gb ?? "?"} / ${s.ram_total_gb ?? "?"} GB`;
    $("tb-pwr-k").textContent = s.ac_online === false ? "PIN" : "AC";
    $("tb-pwr").textContent = `${s.battery_pct ?? 100}%`;
  }

  function buildDrawer() {
    const wrap = $("set-themes");
    wrap.innerHTML = "";
    THEME_ORDER.forEach((key) => {
      const t = THEMES[key];
      const b = el("button", "swatch");
      b.dataset.themeOpt = key;
      const i = el("i");
      i.style.background = t.bg;
      i.style.setProperty("--sw-accent", t.accent);
      b.append(i, el("span", null, t.name));
      b.addEventListener("click", () => setTheme(key));
      wrap.appendChild(b);
    });
  }

  function syncDrawer() {
    const cfg = state.config;
    document.querySelectorAll("[data-theme-opt]").forEach((b) => b.classList.toggle("active", b.dataset.themeOpt === root.dataset.theme));
    document.querySelectorAll("[data-voice-opt]").forEach((b) => b.classList.toggle("active", b.dataset.voiceOpt === cfg.voice));
    document.querySelectorAll("[data-auth-opt]").forEach((b) => b.classList.toggle("active", b.dataset.authOpt === cfg.auth_mode));
    document.querySelectorAll("[data-delay-opt]").forEach((b) => b.classList.toggle("active", Number(b.dataset.delayOpt) === autoDelay()));
    $("set-delay-wrap").classList.toggle("dim", cfg.auth_mode !== "auto");
    $("input-ambient").checked = cfg.ambient_pulse !== false;
    const vol = Math.round((cfg.volume ?? 0.85) * 100);
    $("input-volume").value = String(vol);
    $("volume-val").textContent = `${vol}%`;
    if (document.activeElement !== $("input-operator")) $("input-operator").value = cfg.operator_name || "";
    if (document.activeElement !== $("input-pin")) $("input-pin").value = cfg.pin_code || "2026";
  }

  function applyConfig() {
    const cfg = state.config;
    const themeKey = THEMES[cfg.theme] ? cfg.theme : DEFAULT_THEME;
    if (themeKey !== state.lastTheme) {
      root.dataset.theme = themeKey;
      stage.setPalette(THEMES[themeKey]);
      state.lastTheme = themeKey;
    }
    audio.setVolume(cfg.volume ?? 0.85);
    audio.setMuted(Boolean(cfg.muted));
    audio.setVoiceLang(cfg.voice || "en");
    audio.setAmbient(cfg.ambient_pulse !== false);
    if (cfg.ambient_pulse !== false && state.phase === "ready") audio.startAmbient();

    $("mute-label").textContent = cfg.muted ? "Đang tắt" : "Tiếng";
    const tel = state.telemetry;
    const op = (cfg.operator_name || tel.operator || "operator").toLowerCase();
    $("tb-who").textContent = `${op} @ ${(tel.hostname || "local").toLowerCase()} · ${(tel.os || "").toLowerCase()}`;
    $("tb-version").textContent = tel.ag_version ? `· antigravity ${tel.ag_version}` : "v3";

    stage.setLabel(targetLabel());
    syncTargets();
    syncWorkspaces();
    syncAction();
    syncDrawer();
  }

  function persist(partial) {
    Object.assign(state.config, partial);
    applyConfig();
    callPython("update_config", partial).then((resp) => {
      if (resp && resp.telemetry) {
        const keepWs = state.telemetry.workspaces;
        state.telemetry = { ...resp.telemetry, workspaces: keepWs };
        applyConfig();
      }
    });
  }

  // -------------------------------------------------------------- actions
  function selectTarget(key) {
    if (!TARGET_ORDER.includes(key)) return;
    bumpAuto();
    if (key === state.config.target) return;
    audio.tick(TARGET_ORDER.indexOf(key));
    stage.hop();
    persist({ target: key });
  }

  function cycleTarget(dir) {
    const idx = TARGET_ORDER.indexOf(state.config.target);
    selectTarget(TARGET_ORDER[(idx + dir + TARGET_ORDER.length) % TARGET_ORDER.length]);
  }

  function setTheme(key) {
    if (!THEMES[key]) return;
    bumpAuto();
    audio.tick(2);
    persist({ theme: key });
    stage.hop();
  }

  function cycleTheme() {
    const idx = THEME_ORDER.indexOf(root.dataset.theme);
    setTheme(THEME_ORDER[(idx + 1) % THEME_ORDER.length]);
  }

  function toggleMute() {
    persist({ muted: !state.config.muted });
    if (!state.config.muted) audio.click();
  }

  function cancelAuto() {
    if (effectiveMode() !== "auto") return;
    state.modeOverride = "biometric";
    state.autoActive = false;
    state.autoCharging = false;
    syncAction();
    syncTargets();
  }

  function startAuto() {
    state.autoActive = true;
    state.autoCharging = false;
    state.autoLeft = autoDelay();
    syncAction();
  }

  function startHold(src) {
    if (state.phase !== "ready" || state.settingsOpen) return;
    if (effectiveMode() === "pin") return;
    state.holdSources.add(src);
    if (!state.holding) {
      state.holding = true;
      body.classList.add("holding");
      $("hold-main").textContent = "Giữ tiếp…";
    }
  }

  function endHold(src) {
    state.holdSources.delete(src);
    if (!state.holding || state.holdSources.size) return;
    state.holding = false;
    body.classList.remove("holding");
    $("hold-main").innerHTML = "Giữ <kbd>Space</kbd>";
  }

  function pinKey(key) {
    if (state.phase !== "ready" || effectiveMode() !== "pin" || state.settingsOpen) return;
    if (key === "back") {
      state.pinBuffer = state.pinBuffer.slice(0, -1);
      audio.click();
      syncPin();
      return;
    }
    if (!/^\d$/.test(key) || state.pinBuffer.length >= 4) return;
    const expected = String(state.config.pin_code || "2026").replace(/\D/g, "").padEnd(4, "0").slice(0, 4);
    const next = state.pinBuffer + key;
    if (expected[next.length - 1] !== key) {
      state.pinBuffer = "";
      state.charge = 0;
      syncPin();
      audio.slam();
      stage.slam();
      const row = $("pin-row");
      row.classList.remove("wrong");
      void row.offsetWidth;
      row.classList.add("wrong");
      $("pin-sub").textContent = "Sai rồi. Gõ lại từ đầu.";
      return;
    }
    state.pinBuffer = next;
    audio.clunk(next.length);
    syncPin();
    $("pin-sub").textContent = next.length < 4 ? `${4 - next.length} số nữa…` : "Mở khoá.";
    if (next.length === 4) schedule(liftOff, 230);
  }

  // ------------------------------------------------------------- sequence
  function startSequence() {
    clearTimers();
    state.phase = "drop";
    state.charge = 0;
    state.holding = false;
    state.holdSources.clear();
    state.pinBuffer = "";
    state.autoActive = false;
    state.autoCharging = false;
    state.autoLeft = autoDelay();
    state.modeOverride = null;
    state.launchError = null;
    state.lastPct = -1;
    state.boomed = false;
    body.classList.remove("ui-in", "ui-up", "ui-down", "revealed", "exiting", "holding");
    $("reveal-caption").textContent = "";
    $("hold-main").innerHTML = "Giữ <kbd>Space</kbd>";
    $("pin-sub").textContent = "Gõ 4 số. Mỗi số đúng, chữ nhấc lên một nấc.";
    $("auto-count").textContent = autoDelay().toFixed(1);
    root.style.setProperty("--auto", "1");
    body.classList.remove("auto-paused");
    syncAction();
    syncTargets();

    audio.init();
    if (state.recordAudio) audio.startCapture();
    stage.setLabel(targetLabel());
    stage.dropIn();
    schedule(() => audio.zip(), 30);
    schedule(() => {
      assignFallVars();
      void body.offsetWidth;
      body.classList.add("ui-in");
    }, 520);
  }

  stage.onImpact = (strength, pan) => audio.thud(strength, pan);
  stage.onSlash = (pan) => audio.slash(pan);

  stage.onAllLanded = () => {
    if (state.phase !== "drop") return;
    state.phase = "ready";
    audio.playVoice("intro");
    schedule(() => audio.startAmbient(), 400);
    if (state.spaceDown) startHold("key");
    if (effectiveMode() === "auto" && !state.settingsOpen) startAuto();
  };

  stage.onBoom = () => {
    state.boomed = true;
    audio.boom();
    body.classList.add("ui-up");
  };

  function liftOff() {
    if (state.phase !== "ready" && state.phase !== "drop") return;
    state.phase = "liftoff";
    clearTimers();
    state.holding = false;
    state.holdSources.clear();
    state.autoActive = false;
    state.autoCharging = false;
    state.charge = 1;
    body.classList.remove("holding");

    const label = targetLabel();
    stage.setLabel(label);
    stage.setCharge(1, true);
    audio.stopRiser(true);
    audio.stopAmbient();
    audio.suck();
    stage.liftOff();

    const ws = state.selectedWorkspace;
    schedule(() => {
      callPython("launch_antigravity", state.config.target, ws ? ws.path : null).then((res) => {
        if (res && res.ok === false) showLaunchError(res.error || "Không rõ lỗi");
      });
    }, 120);

    schedule(() => {
      if (!state.launchError) setCaption(ws);
      body.classList.add("revealed");
      audio.pad();
      audio.playVoice("welcome");
    }, 820);

    schedule(finish, 2450);
  }

  function setCaption(ws) {
    const cap = $("reveal-caption");
    cap.textContent = "";
    cap.append("Trọng lực đã tắt. Đang mở ");
    cap.append(el("b", null, ws ? ws.name : "cửa sổ mới"));
    cap.append("…");
  }

  function showLaunchError(message) {
    state.launchError = message;
    const cap = $("reveal-caption");
    cap.textContent = "";
    cap.append(el("span", "err", "Không mở được. "));
    cap.append(String(message));
    body.classList.add("revealed");
    clearTimers();
    schedule(() => startSequence(), 3600);
  }

  function finish() {
    if (state.launchError || state.phase !== "liftoff") return;
    state.phase = "exit";
    body.classList.add("exiting");
    stage.exit();
    schedule(() => {
      if (state.recordAudio) {
        const rec = audio.stopCapture();
        const save = rec ? callPython("save_recording", rec.b64, rec.startEpoch) : Promise.resolve();
        save.finally(() => callPython("complete_and_exit", 420));
      } else if (state.bridge) callPython("complete_and_exit", 420);
      else schedule(startSequence, 1300); // xem thử trên trình duyệt: lặp lại
    }, 380);
  }

  function exitNow() {
    if (state.phase === "exit") return;
    state.phase = "exit";
    clearTimers();
    state.holding = false;
    audio.stopRiser(true);
    audio.stopAmbient();
    audio.fall();
    stage.fallAway();
    body.classList.add("ui-down");
    body.classList.remove("ui-up");
    schedule(() => {
      if (state.bridge) callPython("exit_now");
      else schedule(startSequence, 900);
    }, 560);
  }

  // ----------------------------------------------------------- frame loop
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    const d = new Date();
    if (d.getSeconds() !== state.lastSecond) {
      state.lastSecond = d.getSeconds();
      $("tb-clock").textContent = [d.getHours(), d.getMinutes(), d.getSeconds()]
        .map((v) => String(v).padStart(2, "0"))
        .join(":");
    }

    let engaged = false;
    if (state.phase === "ready") {
      const mode = effectiveMode();
      if (state.autoActive && !state.autoCharging) {
        const paused = autoPaused();
        if (!paused) state.autoLeft -= dt;
        body.classList.toggle("auto-paused", paused);
        $("auto-count").textContent = Math.max(0, state.autoLeft).toFixed(1);
        root.style.setProperty("--auto", clamp(state.autoLeft / autoDelay(), 0, 1).toFixed(3));
        if (state.autoLeft <= 0) {
          state.autoCharging = true;
          body.classList.remove("auto-paused");
        }
      }
      if (state.autoCharging) {
        state.charge = Math.min(1, state.charge + dt / AUTO_CHARGE_SECONDS);
        engaged = true;
      } else if (mode === "pin") {
        const target = state.pinBuffer.length / 4;
        state.charge += (target - state.charge) * Math.min(1, dt * 12);
        engaged = state.pinBuffer.length > 0;
      } else if (state.holding) {
        state.charge = Math.min(1, state.charge + dt / HOLD_SECONDS);
        engaged = true;
      } else {
        state.charge = Math.max(0, state.charge - dt * 2.6);
      }

      stage.setCharge(state.charge, engaged);
      if (state.charge > 0.003) audio.updateRiser(state.charge);
      else audio.stopRiser();

      if (engaged && state.charge >= 0.999 && mode !== "pin") liftOff();
    } else if (state.phase === "drop") {
      stage.setCharge(0, false);
    }

    // đồng hồ trọng lực
    let g = 9.81;
    if (state.boomed) g = -9.81;
    else if (state.phase === "ready" || state.phase === "liftoff") g = 9.81 * (1 - state.charge);
    const gText = (g < 0 ? "−" : "") + Math.abs(g).toFixed(2);
    if (gText !== state.lastG) {
      state.lastG = gText;
      $("g-val").textContent = gText;
      $("gauge").classList.toggle("live", g < 9.8);
    }

    // thanh giữ + rung nhẹ cả khối UI
    const c = state.phase === "ready" || state.phase === "liftoff" ? state.charge : 0;
    const pct = Math.round(c * 100);
    if (pct !== state.lastPct) {
      state.lastPct = pct;
      root.style.setProperty("--charge", c.toFixed(3));
      $("hold-pct").textContent = String(pct);
    }
    if (engaged && c > 0.02) {
      const a = c * c * 3;
      root.style.setProperty("--sx", `${((Math.random() * 2 - 1) * a).toFixed(2)}px`);
      root.style.setProperty("--sy", `${((Math.random() * 2 - 1) * a).toFixed(2)}px`);
    } else if (root.style.getPropertyValue("--sx") !== "0px") {
      root.style.setProperty("--sx", "0px");
      root.style.setProperty("--sy", "0px");
    }

    requestAnimationFrame(frame);
  }

  // --------------------------------------------------------------- drawer
  function openSettings() {
    endHold("key");
    endHold("pointer");
    state.settingsOpen = true;
    audio.click();
    $("drawer-backdrop").classList.remove("hidden");
    $("drawer").classList.add("open");
    $("drawer").setAttribute("aria-hidden", "false");
  }

  function closeSettings() {
    if (!state.settingsOpen) return;
    state.settingsOpen = false;
    $("drawer-backdrop").classList.add("hidden");
    $("drawer").classList.remove("open");
    $("drawer").setAttribute("aria-hidden", "true");
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    if (state.phase === "ready" && effectiveMode() === "auto" && !state.autoActive) startAuto();
  }

  // --------------------------------------------------------------- events
  function bindEvents() {
    const canvas = $("stage-canvas");

    window.addEventListener("pointermove", (e) => stage.setCursor(e.clientX, e.clientY, true), { passive: true });
    document.addEventListener("pointerleave", () => {
      stage.setCursor(-9999, -9999, false);
      state.hoverUI = false;
    });
    // rê chuột lên một lựa chọn = đang suy nghĩ → tạm dừng đếm ngược
    document.addEventListener("pointerover", (e) => {
      state.hoverUI = Boolean(e.target && e.target.closest && e.target.closest(UI_HOVER_SELECTOR));
    });
    window.addEventListener("blur", () => {
      state.spaceDown = false;
      endHold("key");
      endHold("pointer");
    });

    canvas.addEventListener("pointerdown", (e) => {
      audio.init();
      if (state.settingsOpen || state.phase !== "ready") return;
      const idx = stage.hitTest(e.clientX, e.clientY);
      if (idx >= 0) {
        if (stage.flick(idx)) audio.flick();
        bumpAuto();
        return;
      }
      cancelAuto();
      startHold("pointer");
    });
    window.addEventListener("pointerup", () => endHold("pointer"));
    window.addEventListener("pointercancel", () => endHold("pointer"));

    const holdBtn = $("hold-btn");
    holdBtn.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      audio.init();
      startHold("pointer");
    });
    holdBtn.addEventListener("mouseenter", () => audio.hover());

    $("auto-hold").addEventListener("click", () => {
      cancelAuto();
      audio.click();
    });

    $("btn-theme").addEventListener("click", cycleTheme);
    $("btn-mute").addEventListener("click", toggleMute);
    $("btn-settings").addEventListener("click", openSettings);
    $("btn-exit").addEventListener("click", exitNow);
    $("btn-close-settings").addEventListener("click", closeSettings);
    $("drawer-backdrop").addEventListener("click", closeSettings);
    document.querySelectorAll(".key-btn").forEach((b) => b.addEventListener("mouseenter", () => audio.hover()));

    document.querySelectorAll("[data-voice-opt]").forEach((b) =>
      b.addEventListener("click", () => {
        audio.click();
        persist({ voice: b.dataset.voiceOpt });
      })
    );
    document.querySelectorAll("[data-auth-opt]").forEach((b) =>
      b.addEventListener("click", () => {
        audio.click();
        state.modeOverride = null;
        state.pinBuffer = "";
        persist({ auth_mode: b.dataset.authOpt });
      })
    );
    document.querySelectorAll("[data-delay-opt]").forEach((b) =>
      b.addEventListener("click", () => {
        audio.click();
        persist({ auto_delay: Number(b.dataset.delayOpt) });
      })
    );
    $("input-ambient").addEventListener("change", (e) => {
      persist({ ambient_pulse: e.target.checked });
      if (!e.target.checked) audio.stopAmbient();
    });
    $("input-volume").addEventListener("input", (e) => {
      const v = Number(e.target.value) / 100;
      state.config.volume = v;
      audio.setVolume(v);
      $("volume-val").textContent = `${Math.round(v * 100)}%`;
    });
    $("input-volume").addEventListener("change", () => persist({ volume: state.config.volume }));
    $("btn-save-settings").addEventListener("click", () => {
      audio.click();
      const rawPin = $("input-pin").value.replace(/\D/g, "");
      persist({
        operator_name: $("input-operator").value.trim(),
        pin_code: rawPin.length === 4 ? rawPin : state.config.pin_code || "2026",
      });
      closeSettings();
    });
    $("btn-replay").addEventListener("click", () => {
      state.settingsOpen = false;
      $("drawer-backdrop").classList.add("hidden");
      $("drawer").classList.remove("open");
      startSequence();
    });

    window.addEventListener("keydown", (e) => {
      const tag = document.activeElement && document.activeElement.tagName;
      if (e.key === "Escape") {
        if (state.settingsOpen) closeSettings();
        else exitNow();
        return;
      }
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      audio.init();

      if (e.key === " ") {
        e.preventDefault();
        if (e.repeat) return;
        state.spaceDown = true;
        cancelAuto(); // giữ Space = tự tay cất cánh
      }

      const k = e.key.toLowerCase();
      if (k === "t") return cycleTheme();
      if (k === "m") return toggleMute();
      if (k === "s") return state.settingsOpen ? closeSettings() : openSettings();
      if (state.settingsOpen) return;

      if (e.key === "Enter") {
        e.preventDefault();
        liftOff();
        return;
      }
      if (e.key === "ArrowUp" || e.key === "ArrowLeft") return cycleTarget(-1);
      if (e.key === "ArrowDown" || e.key === "ArrowRight") return cycleTarget(1);

      if (effectiveMode() === "pin") {
        if (/^\d$/.test(e.key)) pinKey(e.key);
        else if (e.key === "Backspace") pinKey("back");
        return;
      }
      if (/^[1-3]$/.test(e.key)) return selectTarget(TARGET_ORDER[Number(e.key) - 1]);
      if (e.key === " ") startHold("key");
    });

    window.addEventListener("keyup", (e) => {
      if (e.key === " ") {
        state.spaceDown = false;
        endHold("key");
      }
    });

    window.addEventListener("resize", () => {
      if (body.classList.contains("ui-in")) assignFallVars();
    });
  }

  // ------------------------------------------------------------ bootstrap
  async function bootstrap() {
    buildDigits();
    buildDrawer();
    bindEvents();
    requestAnimationFrame(frame);

    const fontWait = document.fonts
      ? Promise.race([document.fonts.load('100px "Archivo Black"').catch(() => {}), sleep(900)])
      : Promise.resolve();
    const [hasBridge] = await Promise.all([waitForBridge(1100), fontWait]);
    state.bridge = hasBridge;

    if (hasBridge) {
      const data = await callPython("get_bootstrap");
      if (data) {
        if (data.config) Object.assign(state.config, data.config);
        if (data.telemetry) Object.assign(state.telemetry, data.telemetry);
        state.recordAudio = Boolean(data.record_audio);
      }
    }

    const params = new URLSearchParams(window.location.search);
    if (params.get("theme")) state.config.theme = params.get("theme");
    if (params.get("mode")) state.config.auth_mode = params.get("mode");

    buildTargets();
    buildWorkspaces();
    applyConfig();
    renderStats(state.telemetry.stats);

    setInterval(() => {
      if (state.phase === "exit" || !state.bridge) return;
      callPython("get_live_stats").then(renderStats);
    }, 1500);

    window.__launcher = { state, stage, audio, liftOff, startSequence };
    startSequence();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bootstrap, { once: true });
  else bootstrap();
})();

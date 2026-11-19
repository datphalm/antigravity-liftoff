/**
 * Antigravity Launcher v3 — Gravity Stage
 *
 * Một cảnh 2D có vật lý thật (chữ rơi / nảy / nén, sàn là một sợi dây rung,
 * bụi, mảnh vỡ) được vẽ vào canvas ẩn, rồi đưa qua một pass WebGL để làm
 * hậu kỳ: sóng xung kích khúc xạ, tách màu RGB, bloom, film grain, chớp sáng.
 * Không có WebGL thì cảnh vẫn chạy bằng canvas 2D thường.
 */
(() => {
  "use strict";

  const LOGO_PATH =
    "M144.248 149.062c7.5 5.626 18.75 1.876 8.437-8.437-30.937-30-24.375-112.5-62.812-112.5-38.438 0-31.875 82.5-62.813 112.5-11.25 11.25.938 14.063 8.438 8.437 29.062-19.687 27.187-54.375 54.375-54.375 27.187 0 25.312 34.688 54.375 54.375Z";
  const DISPLAY_FONT = '"Archivo Black", "Arial Black", "Segoe UI Black", Impact, sans-serif';
  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const rand = (a, b) => a + Math.random() * (b - a);
  const easeOutCubic = (t) => 1 - Math.pow(1 - clamp(t, 0, 1), 3);

  function hexToRgb(hex) {
    let h = String(hex || "#000").replace("#", "");
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    const n = parseInt(h, 16) || 0;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const mixRgb = (a, b, t) => [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
  const css = (rgb, a = 1) => `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`;

  // ---------------------------------------------------------------- shaders
  const VERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

  const FRAG = `
precision mediump float;
uniform sampler2D uTex;
uniform vec2 uRes;
uniform float uTime;
uniform vec4 uShock;     // x, y (uv), bán kính (đơn vị chiều cao), biên độ
uniform float uAberr;
uniform float uGlow;
uniform float uFlash;
uniform vec3 uFlashCol;
uniform float uInvert;
uniform float uGrain;
uniform float uVig;
uniform float uFade;
uniform vec3 uBg;
varying vec2 vUv;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

void main() {
  vec2 uv = vUv;
  float aspect = uRes.x / uRes.y;

  // Sóng xung kích: khúc xạ một vành tròn đang nở ra
  if (uShock.w > 0.001) {
    vec2 d = uv - uShock.xy;
    d.x *= aspect;
    float dist = length(d);
    float diff = dist - uShock.z;
    float width = 0.12;
    if (abs(diff) < width) {
      float x = diff / width;
      float prof = x * (1.0 - x * x) * (1.0 - x * x);
      vec2 dir = d / max(dist, 0.0001);
      dir.x /= aspect;
      uv -= dir * prof * uShock.w * 0.06;
    }
  }

  // Tách màu RGB theo bán kính
  vec2 c = uv - 0.5;
  vec2 off = c * uAberr * 0.02 + vec2(uAberr * 0.003, 0.0);
  vec3 col;
  col.r = texture2D(uTex, uv + off).r;
  col.g = texture2D(uTex, uv).g;
  col.b = texture2D(uTex, uv - off).b;

  // Bloom rẻ: 2 vòng x 8 mẫu
  if (uGlow > 0.002) {
    vec2 px = 1.0 / uRes;
    vec3 acc = vec3(0.0);
    for (int i = 0; i < 8; i++) {
      float a = float(i) * 0.7853982 + 0.39;
      acc += texture2D(uTex, uv + vec2(cos(a), sin(a)) * px * 10.0).rgb;
    }
    acc /= 8.0;
    vec3 bright = max(acc - uBg - 0.12, 0.0);
    col += bright * uGlow * 1.25;
  }

  // Viền tối
  float v = smoothstep(0.32, 1.0, length(c * vec2(1.0, 1.15)) * 1.3);
  col *= 1.0 - uVig * v;

  col = mix(col, 1.0 - col, uInvert);
  col = mix(col, uFlashCol, uFlash);

  // Film grain — chống cảm giác "nhựa" của gradient số
  float n = hash(gl_FragCoord.xy + fract(uTime * 7.31) * vec2(913.7, 371.3)) - 0.5;
  col += n * uGrain;

  col = mix(col, uBg, uFade);
  gl_FragColor = vec4(col, 1.0);
}`;

  // ------------------------------------------------------------------ stage
  class GravityStage {
    constructor(canvas) {
      this.canvas = canvas;
      // vẽ ở 1x điểm ảnh CSS: chữ rất to + grain nên không thấy mềm, nhưng nhẹ hơn ~36% trên màn 125%
      this.dpr = Math.min(window.devicePixelRatio || 1, 1);
      this.scene = document.createElement("canvas");
      this.gl = null;
      if (!this._initGL()) {
        this.gl = null;
        this.scene = canvas;
      }
      this.ctx = this.scene.getContext("2d", { alpha: false });

      this.word = "ANTIGRAVITY";
      this.label = "ANTIGRAVITY";
      this.letters = [];
      this.slots = [];
      this.sprites = null;
      this.particles = [];
      this.N = 160;
      this.sy = new Float32Array(this.N);
      this.sv = new Float32Array(this.N);
      this.logoPath = new Path2D(LOGO_PATH);
      this.glints = [];
      this.slashes = [];
      this.stars = Array.from({ length: 120 }, () => ({
        x: Math.random(),
        y: Math.random(),
        s: rand(0.6, 1.7),
        p: rand(0, TAU),
        sp: rand(0.6, 2.0),
      }));
      this.art = null;
      this.artSrc = "";
      this.artAlpha = 0;
      this.artKick = 0;
      this.glintSprite = null;
      // Chất lượng tự thích nghi: 2 = đầy đủ, 1 = DPR 1 + tắt bloom, 0 = DPR 0.8
      this.quality = 2;
      this._ema = 16.7;
      this._slowT = 0;

      this.onSlash = null;
      this.onImpact = null;
      this.onAllLanded = null;
      this.onBoom = null;

      this.time = 0;
      this._acc = 0;
      this.setPalette({ bg: "#0b0708", ground: "#140d0e", ink: "#f4efe9", accent: "#ff3b2f" }, true);
      this.reset();
      this.resize();

      window.addEventListener("resize", () => this.resize());
      this._watchFonts();

      this._last = performance.now();
      this._tick = this._tick.bind(this);
      requestAnimationFrame(this._tick);
    }

    // ------------------------------------------------------------- WebGL
    _initGL() {
      try {
        const gl = this.canvas.getContext("webgl", {
          alpha: false,
          antialias: false,
          depth: false,
          stencil: false,
          premultipliedAlpha: false,
          preserveDrawingBuffer: false,
          powerPreference: "high-performance",
        });
        if (!gl) return false;
        const compile = (type, src) => {
          const s = gl.createShader(type);
          gl.shaderSource(s, src);
          gl.compileShader(s);
          if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
            console.warn("[gravity] shader:", gl.getShaderInfoLog(s));
            return null;
          }
          return s;
        };
        const vs = compile(gl.VERTEX_SHADER, VERT);
        const fs = compile(gl.FRAGMENT_SHADER, FRAG);
        if (!vs || !fs) return false;
        const prog = gl.createProgram();
        gl.attachShader(prog, vs);
        gl.attachShader(prog, fs);
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return false;
        gl.useProgram(prog);

        const buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
        const loc = gl.getAttribLocation(prog, "aPos");
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

        const tex = gl.createTexture();
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

        this.u = {};
        [
          "uTex", "uRes", "uTime", "uShock", "uAberr", "uGlow", "uFlash", "uFlashCol",
          "uInvert", "uGrain", "uVig", "uFade", "uBg",
        ].forEach((n) => (this.u[n] = gl.getUniformLocation(prog, n)));
        gl.uniform1i(this.u.uTex, 0);
        this.gl = gl;
        return true;
      } catch (err) {
        console.warn("[gravity] WebGL unavailable, using 2D fallback", err);
        return false;
      }
    }

    // ------------------------------------------------------- configuration
    setPalette(p, silent = false) {
      const bgRgb = hexToRgb(p.bg);
      this.pal = {
        bg: p.bg,
        ink: p.ink,
        accent: p.accent,
        bgRgb,
        groundRgb: hexToRgb(p.ground || p.bg),
        inkRgb: hexToRgb(p.ink),
        accentRgb: hexToRgb(p.accent),
        trail: p.trail || p.accent,
        sheen: Array.isArray(p.sheen) ? p.sheen : null,
        artIdle: typeof p.artIdle === "number" ? p.artIdle : 0.1,
        light: (bgRgb[0] * 0.299 + bgRgb[1] * 0.587 + bgRgb[2] * 0.114) / 255 > 0.5,
      };
      const src = p.art || "";
      if (src !== this.artSrc) {
        this.artSrc = src;
        this.art = null;
        this.artAlpha = 0;
        if (src) {
          const img = new Image();
          img.decoding = "async";
          img.onload = () => {
            if (this.artSrc === src) this.art = img;
          };
          img.src = src;
        }
      }
      this._setArtVideo(p.artVideo || "");
      this._buildGlint();
      if (!silent && this.W) this._layout();
    }

    /**
     * Nền video (540p, 30fps) cho tranh: ảnh tĩnh vẫn là bản dự phòng cho tới khi video
     * có khung hình, và khi máy phải hạ xuống mức chất lượng thấp nhất.
     */
    _setArtVideo(src) {
      if (this.artVideoSrc === src) return;
      this.artVideoSrc = src;
      if (this.artVid) {
        this.artVid.pause();
        this.artVid.removeAttribute("src");
        this.artVid.load();
        this.artVid.remove();
        this.artVid = null;
      }
      if (!src) return;
      const v = document.createElement("video");
      v.muted = true;
      v.defaultMuted = true;
      v.loop = true;
      v.playsInline = true;
      v.autoplay = true;
      v.preload = "auto";
      v.setAttribute("aria-hidden", "true");
      // phải nằm trong DOM để trình duyệt không bỏ qua việc giải mã
      v.style.cssText = "position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none;";
      v.src = src;
      document.body.appendChild(v);
      v.play().catch(() => {});
      this.artVid = v;
    }

    _artSource() {
      const v = this.artVid;
      if (v && this.quality > 0 && v.readyState >= 2 && v.videoWidth) {
        if (v.paused) v.play().catch(() => {});
        return { el: v, w: v.videoWidth, h: v.videoHeight };
      }
      if (this.art) return { el: this.art, w: this.art.naturalWidth, h: this.art.naturalHeight };
      return null;
    }

    /** Ánh sao 4 cánh kiểu manga — vẽ sẵn một lần rồi drawImage */
    _buildGlint() {
      const S = 128;
      const c = S / 2;
      const cv = document.createElement("canvas");
      cv.width = cv.height = S;
      const x = cv.getContext("2d");
      const col = this.pal.light ? this.pal.inkRgb : [255, 255, 255];
      const core = x.createRadialGradient(c, c, 0, c, c, c * 0.45);
      core.addColorStop(0, css(col, 0.95));
      core.addColorStop(0.22, css(col, 0.32));
      core.addColorStop(1, css(col, 0));
      x.fillStyle = core;
      x.fillRect(0, 0, S, S);
      x.fillStyle = css(col, 1);
      const ray = (len, w) => {
        x.beginPath();
        x.moveTo(c, c - len);
        x.lineTo(c + w, c - w);
        x.lineTo(c + len, c);
        x.lineTo(c + w, c + w);
        x.lineTo(c, c + len);
        x.lineTo(c - w, c + w);
        x.lineTo(c - len, c);
        x.lineTo(c - w, c - w);
        x.closePath();
        x.fill();
      };
      ray(c * 0.98, c * 0.065);
      x.save();
      x.globalAlpha = 0.45;
      x.translate(c, c);
      x.rotate(Math.PI / 4);
      x.translate(-c, -c);
      ray(c * 0.4, c * 0.05);
      x.restore();
      this.glintSprite = cv;
    }

    _qualityDpr() {
      const d = Math.min(window.devicePixelRatio || 1, 1);
      return this.quality >= 2 ? d : this.quality === 1 ? d * 0.85 : d * 0.7;
    }

    _applyQuality() {
      this.dpr = this._qualityDpr();
      console.info(`[gravity] quality -> ${this.quality} (dpr ${this.dpr.toFixed(2)})`);
      this.resize();
    }

    setLabel(label) {
      this.label = String(label || "ANTIGRAVITY").toUpperCase();
    }

    setCharge(c, engaged) {
      this.charge = clamp(c, 0, 1);
      this.engaged = Boolean(engaged);
    }

    /** Mức nạp có tác dụng lên hình ảnh — tắt ngay sau cú nổ */
    _charging() {
      if (!this.engaged) return 0;
      if (this.phase === "idle" || this.phase === "drop") return this.charge;
      if (this.phase === "liftoff" && !this._boomDone) return this.charge;
      return 0;
    }

    setCursor(x, y, active) {
      this.cursor.x = x;
      this.cursor.y = y;
      this.cursor.active = active;
    }

    _watchFonts() {
      if (!document.fonts) return;
      const rebuild = () => this._layout();
      document.fonts.load('100px "Archivo Black"').then(rebuild).catch(() => {});
      if (document.fonts.addEventListener) document.fonts.addEventListener("loadingdone", rebuild);
    }

    resize() {
      const W = window.innerWidth;
      const H = window.innerHeight;
      const oldFloor = this.floorY;
      this.W = W;
      this.H = H;
      this.floorY = Math.round(H * 0.6);
      this.scene.width = Math.max(1, Math.round(W * this.dpr));
      this.scene.height = Math.max(1, Math.round(H * this.dpr));
      if (this.gl) {
        this.canvas.width = this.scene.width;
        this.canvas.height = this.scene.height;
        this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      }
      this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      this.g = H * 3.2;
      const dx = W / (this.N - 1);
      this.stringK = Math.pow((W * 0.7) / dx, 2);
      if (oldFloor !== undefined && oldFloor !== this.floorY) {
        const shift = this.floorY - oldFloor;
        this.letters.forEach((L) => (L.y += shift));
      }
      this._layout();
    }

    _layout() {
      if (!this.W) return;
      const ctx = this.ctx;
      const base = 100;
      ctx.font = `${base}px ${DISPLAY_FONT}`;
      let total = 0;
      for (const ch of this.word) total += ctx.measureText(ch).width;
      const track = -0.012;
      total += track * base * (this.word.length - 1);
      this.fs = Math.min((base * this.W * 0.92) / total, this.H * 0.36);
      this._buildSprites();

      const fs = this.fs;
      let width = 0;
      this.sprites.ink.forEach((sp) => (width += sp.adv));
      width += track * fs * (this.word.length - 1);
      let x = (this.W - width) / 2;
      this.slots = this.sprites.ink.map((sp) => {
        const slot = { ox: x, cx: x - sp.left + (sp.left + sp.right) / 2 };
        x += sp.adv + track * fs;
        return slot;
      });
      this.letterTop = this.floorY - this.sprites.ink[0].asc;
    }

    _buildSprites() {
      const fs = this.fs;
      const make = (ch, color, sheen) => {
        const c = this.ctx;
        c.font = `${fs}px ${DISPLAY_FONT}`;
        const m = c.measureText(ch);
        const asc = m.actualBoundingBoxAscent;
        const desc = Math.max(0, m.actualBoundingBoxDescent);
        const left = m.actualBoundingBoxLeft;
        const right = m.actualBoundingBoxRight;
        const pad = Math.ceil(fs * 0.04);
        const w = Math.ceil(left + right + pad * 2);
        const h = Math.ceil(asc + desc + pad * 2);
        const cv = document.createElement("canvas");
        cv.width = Math.max(1, Math.ceil(w * this.dpr));
        cv.height = Math.max(1, Math.ceil(h * this.dpr));
        const x = cv.getContext("2d");
        x.scale(this.dpr, this.dpr);
        x.font = c.font;
        x.textBaseline = "alphabetic";
        x.fillStyle = color;
        if (sheen) {
          // ánh bạc: sáng ở trên, gãy một đường chân trời giữa thân chữ
          const g = x.createLinearGradient(0, pad, 0, pad + asc);
          sheen.forEach(([o, c]) => g.addColorStop(o, c));
          x.fillStyle = g;
        }
        x.fillText(ch, pad + left, pad + asc);
        return { cv, w, h, asc, desc, left, right, pad, adv: m.width };
      };
      const chars = [...this.word];
      this.sprites = {
        ink: chars.map((ch) => make(ch, this.pal.ink, this.pal.sheen)),
        acc: chars.map((ch) => make(ch, this.pal.trail, null)),
      };
    }

    // ---------------------------------------------------------- sequences
    reset() {
      this.phase = "empty";
      this.phaseT = 0;
      this.letters = [...this.word].map((ch, i) => ({
        i,
        ch,
        state: "hidden",
        y: -9999,
        vy: 0,
        rot: 0,
        av: 0,
        rv: 0,
        rotT: 0,
        s: 0,
        sv: 0,
        sT: 0,
        delay: 0,
        launchAt: 0,
        launched: false,
        hopAt: 0,
        trail: [],
      }));
      this.particles.length = 0;
      this.sy.fill(0);
      this.sv.fill(0);
      this.lineIn = 0;
      this.lineInOn = false;
      this.stringAlpha = 1;
      this.stringAlphaTarget = 1;
      this.cutting = false;
      this.cutT = 0;
      this.groundMix = 0;
      this.groundTarget = 0;
      this.charge = 0;
      this.engaged = false;
      this.cursor = this.cursor || { x: -9999, y: -9999, active: false };
      this.trauma = 0;
      this.zoom = 1;
      this.zoomV = 0;
      this.fx = {
        shock: null,
        aberr: 0,
        glow: 0,
        flash: 0,
        invertT: 0,
        fade: 0,
        fadeTarget: 0,
        fadeRate: 3,
      };
      this.reveal = null;
      this._allLandedFired = false;
      this._boomDone = false;
      this._moteCarry = 0;
      this._glintCarry = 0;
      this.glints = [];
      this.slashes = [];
      this.artAlpha = 0;
      this.artKick = 0;
      this.starShift = 0;
      this.starV = 0;
    }

    dropIn() {
      this.reset();
      this.phase = "drop";
      this.phaseT = 0;
      this.lineInOn = true;
      this.groundTarget = 1;
      this.letters.forEach((L, i) => {
        L.state = "waiting";
        L.delay = 0.34 + i * 0.056 + rand(0, 0.045);
        L.y = -rand(0.02, 0.32) * this.H;
        L.vy = rand(0, 0.25) * this.H;
        L.rot = rand(-0.38, 0.38);
        L.av = rand(-1.3, 1.3);
        L.rotT = 0;
      });
    }

    hop() {
      if (this.phase !== "idle") return;
      this.letters.forEach((L, i) => {
        if (L.state === "rest") L.hopAt = this.time + i * 0.03;
      });
    }

    flick(i) {
      const L = this.letters[i];
      if (!L || L.state !== "rest" || this.phase !== "idle") return false;
      L.state = "flick";
      L.vy = -this.H * 1.25;
      const flight = (2 * 1.25) / 3.2;
      L.av = (Math.random() < 0.5 ? -1 : 1) * (TAU / flight);
      this._puff(this.slots[i].cx, this.floorY, 10, 0.5);
      return true;
    }

    slam() {
      this.letters.forEach((L) => {
        if (L.state !== "rest") return;
        if (L.y < this.floorY - 2) L.vy = Math.max(L.vy, 0) + this.H * 0.9;
        else L.sv -= 3.5;
      });
      this.trauma = Math.min(1, this.trauma + 0.55);
      for (let i = 1; i < this.N - 1; i++) this.sv[i] += rand(60, 160) * (this.H / 1080);
    }

    liftOff() {
      if (this.phase === "liftoff" || this.phase === "exit") return;
      this.phase = "liftoff";
      this.phaseT = 0;
      this._boomDone = false;
      const center = (this.letters.length - 1) / 2;
      this.letters.forEach((L, i) => {
        if (L.state === "waiting" || L.state === "hidden") {
          L.state = "gone";
          return;
        }
        L.state = "launch";
        L.launchAt = 0.11 + Math.abs(i - center) * 0.022 + rand(0, 0.02);
        L.launched = false;
        L.trail.length = 0;
        L.sT = -0.17;
      });
    }

    exit() {
      this.phase = "exit";
      if (this.reveal) this.reveal.exiting = true;
      this.fx.fadeTarget = 1;
      this.fx.fadeRate = 2.6;
    }

    fallAway() {
      this.phase = "fall";
      this.phaseT = 0;
      this.letters.forEach((L) => {
        if (L.state === "hidden" || L.state === "gone" || L.state === "waiting") {
          L.state = "gone";
          return;
        }
        L.state = "sink";
        L.vy = Math.max(L.vy, 0) + rand(0, 0.25) * this.H;
        L.av = rand(-1.6, 1.6);
        L.trail.length = 0;
      });
      this.stringAlphaTarget = 0;
      this.groundTarget = 0;
      this.fx.fadeTarget = 1;
      this.fx.fadeRate = 2.2;
      if (this.reveal) this.reveal.exiting = true;
    }

    hitTest(x, y) {
      if (!this.sprites || this.phase !== "idle") return -1;
      for (let i = 0; i < this.letters.length; i++) {
        const L = this.letters[i];
        if (L.state !== "rest") continue;
        const sp = this.sprites.ink[i];
        const slot = this.slots[i];
        if (x >= slot.ox - sp.left && x <= slot.ox + sp.right && y >= L.y - sp.asc && y <= L.y + sp.desc + 6) {
          return i;
        }
      }
      return -1;
    }

    // ------------------------------------------------------------ physics
    _tick(now) {
      const rawMs = Math.min(120, now - this._last);
      const dt = Math.min(0.05, rawMs / 1000);
      this._last = now;
      this.time += dt;
      this.phaseT += dt;

      // Card yếu không giữ nổi 60fps khi đứng chờ → hạ độ phân giải / tắt bloom
      if (this.phase === "idle" && this.quality > 0 && !document.hidden) {
        this._ema += (rawMs - this._ema) * 0.06;
        if (this._ema > 21.5) this._slowT += dt;
        else this._slowT = Math.max(0, this._slowT - dt);
        if (this._slowT > 1.2) {
          this.quality -= 1;
          this._slowT = 0;
          this._ema = 16.7;
          this._applyQuality();
        }
      }

      this._acc += dt;
      const step = 1 / 120;
      let n = 0;
      while (this._acc >= step && n < 8) {
        this._step(step);
        this._acc -= step;
        n++;
      }
      if (n >= 8) this._acc = 0;

      this._updateParticles(dt);
      this._updateFx(dt);
      this._draw();
      this._present();
      requestAnimationFrame(this._tick);
    }

    _step(dt) {
      if (!this.sprites) return;
      const H = this.H;

      // Sàn: đường kẻ được "vẽ" ra từ giữa
      if (this.lineInOn && this.lineIn < 1) this.lineIn = Math.min(1, this.lineIn + dt / 0.36);

      for (let i = 0; i < this.letters.length; i++) this._stepLetter(this.letters[i], i, dt);

      // Sau khi tất cả đã chạm đất và nằm yên
      if (this.phase === "drop" && !this._allLandedFired) {
        let settled = true;
        for (const L of this.letters) {
          if (L.state !== "rest" || Math.abs(L.vy) > this.H * 0.04 || this.floorY - L.y > (L.hover || 0) + 2) {
            settled = false;
            break;
          }
        }
        if (settled) {
          this._allLandedFired = true;
          this.phase = "idle";
          if (this.onAllLanded) this.onAllLanded();
        }
      }

      // Liftoff: khoảnh khắc nổ
      if (this.phase === "liftoff" && !this._boomDone && this.phaseT >= 0.11) this._boom();
      if (this.phase === "liftoff" && !this.reveal && this.phaseT >= 0.58) {
        this.reveal = { y: H * 1.28, vy: -H * 1.9, t: 0, exiting: false };
      }

      // Logo lơ lửng
      const r = this.reveal;
      if (r) {
        r.t += dt;
        if (r.exiting) r.vy -= H * 3.6 * dt;
        else r.vy += (70 * (H * 0.4 - r.y) - 10.5 * r.vy) * dt;
        r.y += r.vy * dt;
      }

      // Sợi dây sàn (phương trình sóng 1D)
      const N = this.N;
      const y = this.sy;
      const v = this.sv;
      const K = this.stringK;
      const h = dt / 2;
      for (let s = 0; s < 2; s++) {
        for (let i = 1; i < N - 1; i++) v[i] += (K * (y[i - 1] + y[i + 1] - 2 * y[i]) - 3.2 * v[i]) * h;
        for (let i = 1; i < N - 1; i++) {
          y[i] += v[i] * h;
          if (y[i] > H * 0.04) y[i] = H * 0.04;
          if (y[i] < -H * 0.08) y[i] = -H * 0.08;
        }
      }
      if (this.cutting) this.cutT += dt;
    }

    _hoverFor(L, i) {
      let h = 0;
      if (this.engaged && this.charge > 0) {
        h += Math.pow(this.charge, 1.3) * this.H * 0.078 * (0.8 + 0.2 * Math.sin(this.time * 5.3 + i * 1.7));
      }
      if (this.cursor.active && (this.phase === "idle" || this.phase === "drop")) {
        const sp = this.sprites.ink[i];
        const dx = (this.slots[i].cx - this.cursor.x) / (this.H * 0.17);
        const dy = (this.floorY - sp.asc * 0.5 - this.cursor.y) / (this.H * 0.22);
        const d2 = dx * dx + dy * dy;
        if (d2 < 1) h += this.H * 0.034 * (1 - d2) * (1 - d2);
      }
      return h;
    }

    _stepLetter(L, i, dt) {
      const H = this.H;
      const floor = this.floorY;

      // lò xo nén/giãn
      L.sv += (-650 * (L.s - L.sT) - 19 * L.sv) * dt;
      L.s = clamp(L.s + L.sv * dt, -0.36, 0.55);

      switch (L.state) {
        case "waiting":
          if (this.phaseT >= L.delay) L.state = "fall";
          break;

        case "fall":
        case "flick":
          L.vy += this.g * dt;
          L.y += L.vy * dt;
          L.rot += L.av * dt;
          this._trail(L);
          if (L.y >= floor && L.vy > 0) this._land(L);
          break;

        case "rest": {
          if (L.hopAt && this.time >= L.hopAt) {
            L.hopAt = 0;
            L.vy = -H * 0.42;
            L.rv += rand(-1.6, 1.6);
          }
          const hover = this._hoverFor(L, i);
          L.hover = hover;
          if (hover > 1.5 && L.vy >= -H * 0.2) {
            const target = floor - hover;
            L.vy += (140 * (target - L.y) - 15 * L.vy) * dt;
            L.y += L.vy * dt;
            if (L.y > floor) {
              L.y = floor;
              if (L.vy > 0) L.vy = 0;
            }
          } else if (L.y < floor - 0.01 || L.vy < 0) {
            L.vy += this.g * dt;
            L.y += L.vy * dt;
            if (L.y >= floor) this._land(L);
          } else {
            L.y = floor;
            L.vy = 0;
          }
          L.rv += (-95 * (L.rot - L.rotT) - 11 * L.rv) * dt;
          L.rot += L.rv * dt;
          if (L.trail.length) L.trail.shift();
          break;
        }

        case "launch":
          if (!L.launched) {
            if (this.phaseT >= L.launchAt) {
              L.launched = true;
              L.vy = -H * rand(1.7, 2.5);
              L.av = rand(-3.4, 3.4);
              L.sT = 0;
              L.sv += 7;
            }
          } else {
            L.vy -= H * 4.2 * dt;
            L.y += L.vy * dt;
            L.rot += L.av * dt;
            this._trail(L);
            if (L.y < -H * 0.7) L.state = "gone";
          }
          break;

        case "sink":
          L.vy += this.g * dt;
          L.y += L.vy * dt;
          L.rot += L.av * dt;
          this._trail(L);
          if (L.y - this.sprites.ink[i].asc > H * 1.1) L.state = "gone";
          break;

        default:
          break;
      }
    }

    _trail(L) {
      L.trail.push({ x: this.slots[L.i].cx, y: L.y, rot: L.rot, s: L.s });
      if (L.trail.length > 7) L.trail.shift();
    }

    _land(L) {
      const v = L.vy;
      const H = this.H;
      L.y = this.floorY;
      if (v > H * 0.1) {
        const strength = clamp(v / (H * 2.4), 0, 1);
        L.vy = -v * 0.24;
        L.sv -= (v / H) * 3.1;
        const cx = this.slots[L.i].cx;
        this._puff(cx, this.floorY, 5 + strength * 28, strength);
        this._pluck(cx, v * 0.09, this.fs * 0.32);
        this.trauma = Math.min(1, this.trauma + strength * 0.3);
        if (this.onImpact) this.onImpact(strength, (cx / this.W) * 2 - 1);
      } else {
        L.vy = 0;
      }
      if (L.state === "fall" || L.state === "flick") {
        L.state = "rest";
        L.rotT = Math.round(L.rot / TAU) * TAU;
        L.rv = L.av * 0.25;
        L.trail.length = 0;
      }
    }

    _pluck(x, amount, width) {
      const dx = this.W / (this.N - 1);
      const c = x / dx;
      const w = Math.max(1, width / dx);
      const i0 = Math.max(1, Math.floor(c - w * 3));
      const i1 = Math.min(this.N - 2, Math.ceil(c + w * 3));
      for (let i = i0; i <= i1; i++) {
        const k = (i - c) / w;
        this.sv[i] += amount * Math.exp(-k * k);
      }
    }

    _boom() {
      this._boomDone = true;
      const H = this.H;
      const fx = this.fx;
      fx.flash = this.pal.light ? 0.25 : 0.85;
      fx.invertT = 0.065;
      fx.aberr = 1.3;
      fx.glow = 1.25;
      fx.shock = { x: this.W / 2, y: this.floorY, t: 0 };
      this.trauma = 1;
      this.zoomV -= 1.5;
      this.cutting = true;
      this.cutT = 0;
      this.stringAlphaTarget = 0;
      this.groundTarget = 0;
      for (let i = 1; i < this.N - 1; i++) this.sv[i] -= rand(260, 640) * (H / 1080);
      this._debris();
      this.artAlpha = this.art ? 0.95 : 0;
      this.artKick = 0.09;
      this.starV = H * 2.6;
      if (!this.pal.light) {
        // một ngôi sao khổng lồ + vệt loé ngang, rồi sao nhỏ rải khắp trời
        this.glints.push({ li: -1, x: this.W / 2, y: this.floorY, size: H * 0.95, t: 0, max: 0.8, rot: 0, spin: 0.3, delay: 0, flare: true, alpha: 1 });
        for (let k = 0; k < 16; k++) {
          this.glints.push({
            li: -1,
            x: rand(0.05, 0.95) * this.W,
            y: rand(0.06, 0.9) * H,
            size: H * rand(0.025, 0.075),
            t: 0,
            max: rand(0.5, 0.9),
            rot: rand(-0.15, 0.15),
            spin: rand(-0.8, 0.8),
            delay: rand(0.05, 0.6),
            alpha: 1,
          });
        }
      }
      this._spawnSlashes();
      if (this.onBoom) this.onBoom();
    }

    /** Nét mực chém ngang màn hình lúc nổ */
    _spawnSlashes() {
      const W = this.W;
      const H = this.H;
      const n = this.quality === 0 ? 3 : 5;
      for (let k = 0; k < n; k++) {
        const ang = (Math.random() < 0.5 ? -1 : 1) * rand(0.16, 0.6);
        const cx = W * rand(0.22, 0.78);
        const cy = H * rand(0.15, 0.62);
        const len = W * rand(0.75, 1.3);
        const dx = (Math.cos(ang) * len) / 2;
        const dy = (Math.sin(ang) * len) / 2;
        const dir = Math.random() < 0.5 ? 1 : -1;
        const bend = rand(-0.16, 0.16) * len;
        this.slashes.push({
          p0: { x: cx - dx * dir, y: cy - dy * dir },
          p1: { x: cx - Math.sin(ang) * bend, y: cy + Math.cos(ang) * bend },
          p2: { x: cx + dx * dir, y: cy + dy * dir },
          w: H * rand(0.008, 0.024),
          t: 0,
          delay: k * 0.05 + rand(0, 0.03),
          dur: rand(0.09, 0.15),
          fade: rand(0.35, 0.6),
          fired: false,
          cx,
        });
      }
    }

    _spawnGlint(onLetter) {
      const H = this.H;
      let g;
      if (onLetter && this.sprites) {
        const idxs = [];
        this.letters.forEach((L, i) => L.state === "rest" && idxs.push(i));
        if (!idxs.length) return;
        const i = idxs[Math.floor(Math.random() * idxs.length)];
        const sp = this.sprites.ink[i];
        const top = Math.random() < 0.62;
        g = {
          li: i,
          ox: top ? rand(-sp.left, sp.right) : (Math.random() < 0.5 ? -sp.left : sp.right) + rand(-2, 2),
          oy: top ? -sp.asc * rand(0.9, 1.0) : -sp.asc * rand(0.15, 0.95),
        };
      } else {
        g = { li: -1, x: rand(0.04, 0.96) * this.W, y: rand(0.08, 0.92) * this.floorY };
      }
      Object.assign(g, {
        size: H * rand(0.018, 0.05) * (1 + this._charging() * 0.9),
        t: 0,
        max: rand(0.55, 1.1),
        rot: rand(-0.12, 0.12),
        spin: rand(-0.6, 0.6),
        delay: 0,
        alpha: 1,
      });
      if (this.glints.length < 70) this.glints.push(g);
    }

    // ---------------------------------------------------------- particles
    _spawn(p) {
      if (this.particles.length > 1400) this.particles.shift();
      this.particles.push(p);
    }

    _puff(x, y, count, strength) {
      const H = this.H;
      const spread = this.fs * 0.45;
      for (let k = 0; k < count; k++) {
        const dir = Math.random() < 0.5 ? -1 : 1;
        const drop = Math.random() < 0.3; // giọt mực văng xa, kéo vệt
        this._spawn({
          x: x + rand(-spread, spread),
          y: y - rand(0, 3),
          vx: dir * rand(0.04, drop ? 0.6 : 0.36) * H * (0.4 + strength),
          vy: -rand(0.02, drop ? 0.4 : 0.22) * H * (0.4 + strength),
          ax: 0,
          ay: H * 1.4,
          drag: drop ? 1.2 : 2.6,
          life: rand(0.45, 1.1),
          max: 1.1,
          size: drop ? rand(1, 2.2) : rand(1.2, 4.4),
          alpha: rand(0.4, 0.9),
          acc: Math.random() < 0.12,
          streak: drop,
        });
      }
    }

    _debris() {
      const W = this.W;
      const H = this.H;
      const count = this.quality === 0 ? 220 : 440;
      for (let k = 0; k < count; k++) {
        const x = rand(-0.02, 1.02) * W;
        const fromC = (x - W / 2) / (W / 2);
        const big = Math.random() < 0.08;
        this._spawn({
          x,
          y: this.floorY + rand(-2, 8),
          vx: fromC * rand(0, 0.32) * H + rand(-0.08, 0.08) * H,
          vy: -rand(0.35, 2.5) * H,
          ax: 0,
          ay: -rand(0.6, 2.1) * H,
          drag: 0.15,
          life: rand(0.7, 1.7),
          max: 1.7,
          size: big ? rand(3.5, 6.5) : rand(1, 3),
          alpha: rand(0.5, 1),
          acc: Math.random() < 0.36,
          streak: !big && Math.random() < 0.6,
        });
      }
      // tia lửa quét ngang mặt sàn
      for (let k = 0; k < 90; k++) {
        const dir = Math.random() < 0.5 ? -1 : 1;
        this._spawn({
          x: W / 2 + rand(-20, 20),
          y: this.floorY + rand(-3, 3),
          vx: dir * rand(0.6, 2.4) * H,
          vy: -rand(0, 0.3) * H,
          ax: 0,
          ay: -H * 0.2,
          drag: 1.1,
          life: rand(0.35, 0.8),
          max: 0.8,
          size: rand(1.2, 2.6),
          alpha: 1,
          acc: Math.random() < 0.55,
          streak: true,
        });
      }
    }

    _updateParticles(dt) {
      const H = this.H;
      const W = this.W;

      // Đang nạp: bụi bốc ngược lên khỏi sàn
      if ((this.phase === "idle" || this.phase === "drop") && this.engaged && this.charge > 0.01 && this.sprites) {
        this._moteCarry += this.charge * 110 * dt;
        const left = this.slots[0].ox;
        const right = this.slots[this.slots.length - 1].ox + this.sprites.ink[this.slots.length - 1].right;
        while (this._moteCarry >= 1) {
          this._moteCarry -= 1;
          this._spawn({
            x: rand(left, right),
            y: this.floorY - rand(0, 4),
            vx: rand(-0.02, 0.02) * H,
            vy: -rand(0.04, 0.24) * H,
            ax: 0,
            ay: -H * 0.35 * this.charge,
            drag: 0.4,
            life: rand(0.8, 1.6),
            max: 1.6,
            size: rand(1, 2.6),
            alpha: rand(0.3, 0.85),
            acc: Math.random() < 0.3,
            streak: false,
          });
        }
        // tia lửa ở hai đầu thanh nạp
        const half = this.charge * W * 0.5;
        if (Math.random() < 0.6 + this.charge * 0.4) {
          [-1, 1].forEach((dir) =>
            this._spawn({
              x: W / 2 + dir * half,
              y: this.floorY,
              vx: dir * rand(0.1, 0.45) * H,
              vy: -rand(0.02, 0.3) * H,
              ax: 0,
              ay: H * 0.8,
              drag: 2,
              life: rand(0.2, 0.45),
              max: 0.45,
              size: rand(1, 2),
              alpha: 1,
              acc: true,
              streak: true,
            })
          );
        }
      }

      // Lúc logo lơ lửng: bụi trôi lên chậm
      if (this.reveal && !this.reveal.exiting && Math.random() < dt * 50) {
        this._spawn({
          x: rand(0, W),
          y: H + 10,
          vx: rand(-0.01, 0.01) * H,
          vy: -rand(0.05, 0.22) * H,
          ax: 0,
          ay: -H * 0.04,
          drag: 0,
          life: 3.5,
          max: 3.5,
          size: rand(1, 2.2),
          alpha: rand(0.2, 0.55),
          acc: Math.random() < 0.25,
          streak: false,
        });
      }

      // Ánh sao lấp lánh trên chữ / trên trời — dày lên khi nạp
      if (!this.pal.light && (this.phase === "idle" || this.phase === "drop")) {
        this._glintCarry += (0.9 + this._charging() * 11) * dt;
        while (this._glintCarry >= 1) {
          this._glintCarry -= 1;
          this._spawnGlint(Math.random() < 0.72);
        }
      }
      const gl = this.glints;
      let gw = 0;
      for (let k = 0; k < gl.length; k++) {
        const g = gl[k];
        if (g.delay > 0) {
          g.delay -= dt;
          gl[gw++] = g;
          continue;
        }
        g.t += dt;
        if (g.t >= g.max) continue;
        if (g.li >= 0) {
          const L = this.letters[g.li];
          if (!L || L.state === "gone" || L.state === "hidden") continue;
        }
        gl[gw++] = g;
      }
      gl.length = gw;

      // Nét mực
      const sl = this.slashes;
      let sw = 0;
      for (let k = 0; k < sl.length; k++) {
        const s = sl[k];
        if (s.delay > 0) {
          s.delay -= dt;
          sl[sw++] = s;
          continue;
        }
        if (!s.fired) {
          s.fired = true;
          if (this.onSlash) this.onSlash((s.cx / W) * 2 - 1);
        }
        s.t += dt;
        if (s.t < s.dur + s.fade) sl[sw++] = s;
      }
      sl.length = sw;

      // Sao trời trôi xuống khi "camera" bay lên sau cú nổ
      this.starShift += this.starV * dt;
      this.starV *= Math.exp(-dt * 1.6);

      const ps = this.particles;
      let w = 0;
      for (let k = 0; k < ps.length; k++) {
        const p = ps[k];
        p.life -= dt;
        if (p.life <= 0 || p.y < -H * 0.3 || p.y > H * 1.3) continue;
        p.vx += p.ax * dt;
        p.vy += p.ay * dt;
        const d = Math.max(0, 1 - p.drag * dt);
        p.vx *= d;
        p.vy *= d;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        ps[w++] = p;
      }
      ps.length = w;
    }

    // ----------------------------------------------------------------- fx
    _updateFx(dt) {
      const fx = this.fx;
      const charging = this._charging();
      fx.flash *= Math.exp(-dt * 6.5);
      fx.invertT -= dt;
      const aTarget = 0.05 + charging * charging * 0.6;
      fx.aberr += (aTarget - fx.aberr) * Math.min(1, dt * 3.2);
      const gTarget = charging * 0.5 + (this.reveal ? 0.3 : 0);
      fx.glow += (gTarget - fx.glow) * Math.min(1, dt * 2.6);
      if (fx.shock) {
        fx.shock.t += dt;
        if (fx.shock.t > 1.25) fx.shock = null;
      }
      fx.fade += (fx.fadeTarget - fx.fade) * Math.min(1, dt * fx.fadeRate);

      // Tranh nền: mờ khi chờ, rõ dần khi nạp, loé lúc nổ, dịu lại khi logo hiện
      let at = 0;
      if (this.art) {
        const base = this.pal.artIdle;
        if (this.phase === "drop") at = base * clamp(this.phaseT / 1.4, 0, 1);
        else if (this.phase === "idle") at = base + charging * 0.32;
        else if (this.phase === "liftoff") at = this._boomDone ? (this.reveal ? 0.34 : 0.55) : 0.5;
        else if (this.phase === "exit") at = this.reveal ? 0.34 : 0;
      }
      this.artAlpha += (at - this.artAlpha) * Math.min(1, dt * (this._boomDone ? 2.2 : 3.5));
      this.artKick *= Math.exp(-dt * 3);

      this.trauma = Math.max(0, this.trauma - dt * 1.5);
      this.stringAlpha += (this.stringAlphaTarget - this.stringAlpha) * Math.min(1, dt * (this.cutting ? 2.2 : 5));
      this.groundMix += (this.groundTarget - this.groundMix) * Math.min(1, dt * (this.groundTarget ? 4 : 2.4));

      const anticipating = this.phase === "liftoff" && !this._boomDone;
      const zt = 1 + charging * 0.032 + (anticipating ? 0.025 : 0);
      this.zoomV += (90 * (zt - this.zoom) - 13 * this.zoomV) * dt;
      this.zoom += this.zoomV * dt;
    }

    // --------------------------------------------------------------- draw
    _stringPath(ctx, from, to) {
      const N = this.N;
      const dx = this.W / (N - 1);
      const y0 = this.floorY;
      const i0 = Math.max(0, Math.floor(from / dx));
      const i1 = Math.min(N - 1, Math.ceil(to / dx));
      const at = (x) => {
        const f = clamp(x / dx, 0, N - 1);
        const a = Math.floor(f);
        const b = Math.min(N - 1, a + 1);
        return y0 + this.sy[a] + (this.sy[b] - this.sy[a]) * (f - a);
      };
      ctx.moveTo(from, at(from));
      for (let i = i0 + 1; i < i1; i++) ctx.lineTo(i * dx, y0 + this.sy[i]);
      ctx.lineTo(to, at(to));
    }

    _draw() {
      const ctx = this.ctx;
      const W = this.W;
      const H = this.H;
      const pal = this.pal;
      const t = this.time;
      if (!this.sprites) return;

      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.globalAlpha = 1;
      ctx.fillStyle = pal.bg;
      ctx.fillRect(0, 0, W, H);

      // Camera: rung + zoom quanh tâm sàn
      const charging = this._charging();
      const sh = this.trauma * this.trauma + Math.pow(charging, 3) * 0.13;
      const ox = sh * H * 0.02 * (Math.sin(t * 67.1) * 0.6 + Math.sin(t * 39.7 + 1.7) * 0.4);
      const oy = sh * H * 0.02 * (Math.sin(t * 59.3 + 0.4) * 0.6 + Math.sin(t * 31.1 + 2.2) * 0.4);
      ctx.save();
      ctx.translate(W / 2 + ox, this.floorY + oy);
      ctx.rotate(sh * 0.006 * Math.sin(t * 23.9));
      ctx.scale(this.zoom, this.zoom);
      ctx.translate(-W / 2, -this.floorY);

      // Tranh nền (theme Mực bạc) — video chạy, ảnh tĩnh là dự phòng
      const artSrc = this.artAlpha > 0.004 ? this._artSource() : null;
      if (artSrc) {
        const img = artSrc.el;
        const iw = artSrc.w;
        const ih = artSrc.h;
        const sc = Math.max(W / iw, H / ih) * (1.05 + charging * 0.05 + this.artKick);
        const dw = iw * sc;
        const dh = ih * sc;
        const px = this.cursor.active ? (this.cursor.x / W - 0.5) * -16 : 0;
        const py = this.cursor.active ? (this.cursor.y / H - 0.5) * -9 : 0;
        ctx.globalAlpha = clamp(this.artAlpha, 0, 1);
        ctx.drawImage(img, (W - dw) / 2 + px, (H - dh) / 2 + py, dw, dh);
        ctx.globalAlpha = 1;
      }

      // Sao trời
      if (!pal.light) {
        const streak = Math.min(this.starV * 0.025, H * 0.12);
        ctx.fillStyle = pal.ink;
        for (const s of this.stars) {
          const tw = 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(t * s.sp + s.p));
          ctx.globalAlpha = tw * 0.5;
          const y = (((s.y * H + this.starShift) % H) + H) % H;
          ctx.fillRect(s.x * W, y - streak, s.s, s.s + streak);
        }
        ctx.globalAlpha = 1;
      }

      // Mặt đất
      const lineHalf = easeOutCubic(this.lineIn) * W * 0.5;
      if (this.groundMix > 0.004) {
        // mặt đất mờ dần (không chỉ đổi màu) để tranh nền lộ ra hết sau cú nổ
        ctx.globalAlpha = clamp(this.groundMix, 0, 1);
        ctx.fillStyle = css(pal.groundRgb);
        ctx.beginPath();
        ctx.moveTo(-W * 0.2, this.floorY + this.sy[0]);
        this._stringPath(ctx, 0, W);
        ctx.lineTo(W * 1.2, this.floorY + this.sy[this.N - 1]);
        ctx.lineTo(W * 1.2, H * 1.3);
        ctx.lineTo(-W * 0.2, H * 1.3);
        ctx.closePath();
        ctx.fill();
        ctx.globalAlpha = 1;
      }

      // Ánh nạp loang xuống mặt đất
      if (charging > 0.01) {
        const half = charging * W * 0.5;
        const g = ctx.createLinearGradient(0, this.floorY, 0, this.floorY + H * 0.16);
        g.addColorStop(0, css(pal.accentRgb, 0.2 * charging));
        g.addColorStop(1, css(pal.accentRgb, 0));
        ctx.fillStyle = g;
        ctx.fillRect(W / 2 - half, this.floorY, half * 2, H * 0.16);
      }

      // Vòng xung kích (để sóng vẫn thấy được trên nền trống)
      const shock = this.fx.shock;
      if (shock) {
        const r = shock.t * 1.15 * H;
        const a = Math.pow(1 - shock.t / 1.25, 2);
        ctx.lineWidth = 2;
        ctx.strokeStyle = css(pal.accentRgb, 0.5 * a);
        ctx.beginPath();
        ctx.arc(shock.x, shock.y, r, 0, TAU);
        ctx.stroke();
        ctx.lineWidth = 1;
        ctx.strokeStyle = css(pal.inkRgb, 0.25 * a);
        ctx.beginPath();
        ctx.arc(shock.x, shock.y, r * 0.82, 0, TAU);
        ctx.stroke();
      }

      // Chữ
      this._drawLetters(ctx, charging);

      // Sợi dây sàn + thanh nạp
      if (this.stringAlpha > 0.01 && lineHalf > 0.5) {
        let segs;
        if (this.cutting) {
          const ce = easeOutCubic(this.cutT / 0.42) * W * 0.5;
          segs = [
            [W / 2 - lineHalf, W / 2 - ce],
            [W / 2 + ce, W / 2 + lineHalf],
          ];
        } else {
          segs = [[W / 2 - lineHalf, W / 2 + lineHalf]];
        }
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        ctx.strokeStyle = css(pal.inkRgb, 0.55 * this.stringAlpha);
        ctx.lineWidth = 1.25;
        segs.forEach(([a, b]) => {
          if (b - a < 1) return;
          ctx.beginPath();
          this._stringPath(ctx, a, b);
          ctx.stroke();
        });

        if (this.charge > 0.003 && !this.cutting) {
          const half = this.charge * W * 0.5;
          ctx.strokeStyle = css(pal.accentRgb, 0.16 * this.stringAlpha);
          ctx.lineWidth = 10 + this.charge * 16;
          ctx.beginPath();
          this._stringPath(ctx, W / 2 - half, W / 2 + half);
          ctx.stroke();
          ctx.strokeStyle = css(pal.accentRgb, this.stringAlpha);
          ctx.lineWidth = 2 + this.charge * 2.5;
          ctx.beginPath();
          this._stringPath(ctx, W / 2 - half, W / 2 + half);
          ctx.stroke();
        }
      }

      // Hạt, nét mực, ánh sao
      this._drawParticles(ctx);
      this._drawSlashes(ctx);
      this._drawGlints(ctx);

      // Logo lơ lửng
      if (this.reveal) this._drawReveal(ctx);

      ctx.restore();
    }

    _drawSlashes(ctx) {
      if (!this.slashes.length) return;
      const N = 26;
      const L = new Array(N);
      const R = new Array(N);
      ctx.fillStyle = this.pal.ink;
      ctx.strokeStyle = this.pal.ink;
      for (const s of this.slashes) {
        if (s.delay > 0) continue;
        const head = easeOutCubic(s.t / s.dur);
        const tail = s.t > s.dur * 0.5 ? Math.pow(clamp((s.t - s.dur * 0.5) / s.fade, 0, 1), 1.6) : 0;
        if (head - tail < 0.01) continue;
        const { p0, p1, p2 } = s;
        for (let i = 0; i < N; i++) {
          const v = i / (N - 1);
          const u = tail + (head - tail) * v;
          const a = 1 - u;
          const bx = a * a * p0.x + 2 * a * u * p1.x + u * u * p2.x;
          const by = a * a * p0.y + 2 * a * u * p1.y + u * u * p2.y;
          let tx = 2 * a * (p1.x - p0.x) + 2 * u * (p2.x - p1.x);
          let ty = 2 * a * (p1.y - p0.y) + 2 * u * (p2.y - p1.y);
          const tl = Math.hypot(tx, ty) || 1;
          tx /= tl;
          ty /= tl;
          const w = s.w * Math.pow(Math.sin(Math.PI * v), 0.55) * (0.55 + 0.45 * v);
          L[i] = [bx - ty * w, by + tx * w];
          R[i] = [bx + ty * w, by - tx * w];
        }
        ctx.globalAlpha = 1 - clamp((s.t - s.dur) / s.fade, 0, 1) * 0.7;
        ctx.beginPath();
        ctx.moveTo(L[0][0], L[0][1]);
        for (let i = 1; i < N; i++) ctx.lineTo(L[i][0], L[i][1]);
        for (let i = N - 1; i >= 0; i--) ctx.lineTo(R[i][0], R[i][1]);
        ctx.closePath();
        ctx.fill();
        // sợi mực mảnh tách ra bên cạnh
        ctx.globalAlpha *= 0.4;
        ctx.lineWidth = 1;
        ctx.beginPath();
        const off = s.w * 2.4;
        for (let i = 2; i < N - 2; i++) {
          const [lx, ly] = L[i];
          const [rx, ry] = R[i];
          const nx = (lx - rx) / (2 * s.w || 1);
          const ny = (ly - ry) / (2 * s.w || 1);
          const mx = (lx + rx) / 2 + nx * off;
          const my = (ly + ry) / 2 + ny * off;
          if (i === 2) ctx.moveTo(mx, my);
          else ctx.lineTo(mx, my);
        }
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    _drawGlints(ctx) {
      if (!this.glints.length || !this.glintSprite) return;
      ctx.save();
      ctx.globalCompositeOperation = this.pal.light ? "source-over" : "lighter";
      for (const g of this.glints) {
        if (g.delay > 0) continue;
        const env = Math.sin(Math.PI * clamp(g.t / g.max, 0, 1));
        const a = env * g.alpha;
        if (a < 0.01) continue;
        let x = g.x;
        let y = g.y;
        if (g.li >= 0) {
          const L = this.letters[g.li];
          x = this.slots[g.li].ox + g.ox;
          y = L.y + g.oy;
        }
        const s = g.size * (0.55 + 0.45 * env);
        const r = g.rot + g.spin * g.t;
        ctx.globalAlpha = a;
        ctx.translate(x, y);
        ctx.rotate(r);
        ctx.drawImage(this.glintSprite, -s, -s, s * 2, s * 2);
        ctx.rotate(-r);
        if (g.flare) {
          const len = this.W * 0.8 * env;
          const grad = ctx.createLinearGradient(-len, 0, len, 0);
          grad.addColorStop(0, "rgba(255,255,255,0)");
          grad.addColorStop(0.5, "rgba(255,255,255,0.9)");
          grad.addColorStop(1, "rgba(255,255,255,0)");
          ctx.fillStyle = grad;
          ctx.fillRect(-len, -1.5, len * 2, 3);
        }
        ctx.translate(-x, -y);
      }
      ctx.restore();
    }

    _drawLetters(ctx, charging) {
      const H = this.H;
      const t = this.time;
      const anticipating = this.phase === "liftoff" && !this._boomDone;
      for (let i = 0; i < this.letters.length; i++) {
        const L = this.letters[i];
        if (L.state === "hidden" || L.state === "gone" || L.state === "waiting") continue;
        const sp = this.sprites.ink[i];
        const sa = this.sprites.acc[i];
        const slot = this.slots[i];

        // vệt chuyển động màu nhấn
        const speed = Math.abs(L.vy) / (H * 1.5);
        if (L.trail.length > 1 && speed > 0.15) {
          for (let k = 0; k < L.trail.length - 1; k++) {
            const tr = L.trail[k];
            const a = ((k + 1) / L.trail.length) * 0.34 * clamp(speed, 0, 1);
            this._blit(ctx, sa, slot, tr.x, tr.y, tr.rot, tr.s, a);
          }
        }

        let jx = 0;
        let jy = 0;
        let jr = 0;
        const j = Math.max(charging * charging, anticipating ? 0.8 : 0);
        if (j > 0.001) {
          jx = j * H * 0.0045 * Math.sin(t * 53 + i * 7.1);
          jy = j * H * 0.0035 * Math.sin(t * 47 + i * 3.7);
          jr = j * 0.035 * Math.sin(t * 31 + i * 2.9);
        }
        this._blit(ctx, sp, slot, slot.cx + jx, L.y + jy, L.rot + jr, L.s, 1);
      }
    }

    _blit(ctx, sp, slot, cx, y, rot, s, alpha) {
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(cx, y);
      if (rot) {
        const mid = -sp.asc * 0.5;
        ctx.translate(0, mid);
        ctx.rotate(rot);
        ctx.translate(0, -mid);
      }
      if (s) ctx.scale(1 - s * 0.55, 1 + s);
      ctx.drawImage(sp.cv, -(slot.cx - slot.ox) - sp.left - sp.pad, -sp.asc - sp.pad, sp.w, sp.h);
      ctx.restore();
    }

    _drawParticles(ctx) {
      const ps = this.particles;
      if (!ps.length) return;
      const cols = [this.pal.inkRgb, this.pal.accentRgb];
      ctx.lineCap = "round";
      for (let c = 0; c < 2; c++) {
        const col = css(cols[c]);
        ctx.fillStyle = col;
        ctx.strokeStyle = col;
        const wantAcc = c === 1;
        for (let k = 0; k < ps.length; k++) {
          const p = ps[k];
          if (p.acc !== wantAcc) continue;
          ctx.globalAlpha = clamp(p.life / (p.max * 0.6), 0, 1) * p.alpha;
          if (p.streak) {
            ctx.lineWidth = p.size * 0.85;
            ctx.beginPath();
            ctx.moveTo(p.x - p.vx * 0.018, p.y - p.vy * 0.018);
            ctx.lineTo(p.x, p.y);
            ctx.stroke();
          } else if (p.size > 2.4) {
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.size * 0.5, 0, TAU);
            ctx.fill();
          } else {
            ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
          }
        }
      }
      ctx.globalAlpha = 1;
    }

    _drawReveal(ctx) {
      const r = this.reveal;
      const H = this.H;
      const S = H * 0.24;
      const k = S / 150;
      const bob = r.exiting ? 0 : Math.sin(r.t * 1.7) * H * 0.006;
      const rot = r.exiting ? 0 : Math.sin(r.t * 1.15) * 0.022;
      const speed = clamp(Math.abs(r.vy) / (H * 1.2), 0, 1);

      const drawLogo = (y, color, alpha, sheen) => {
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.translate(this.W / 2, y);
        ctx.rotate(rot);
        ctx.scale(k, k);
        ctx.translate(-90, -92);
        if (sheen) {
          const g = ctx.createLinearGradient(0, 28, 0, 152);
          sheen.forEach(([o, c]) => g.addColorStop(o, c));
          ctx.fillStyle = g;
        } else {
          ctx.fillStyle = color;
        }
        ctx.fill(this.logoPath);
        ctx.restore();
      };

      // nền tối mềm sau logo để nổi trên tranh
      if (this.art) {
        const cx = this.W / 2;
        const cy = r.y + bob + S * 0.25;
        const rg = ctx.createRadialGradient(cx, cy, 0, cx, cy, H * 0.42);
        rg.addColorStop(0, css(this.pal.bgRgb, 0.78));
        rg.addColorStop(1, css(this.pal.bgRgb, 0));
        ctx.fillStyle = rg;
        ctx.fillRect(cx - H * 0.42, cy - H * 0.42, H * 0.84, H * 0.84);
      }

      // vệt bay theo vận tốc
      if (speed > 0.08) {
        for (let e = 3; e >= 1; e--) {
          drawLogo(r.y + bob - r.vy * 0.016 * e, this.pal.trail, 0.12 * speed * (4 - e));
        }
      }
      drawLogo(r.y + bob, this.pal.accent, 1, this.pal.sheen);

      // ánh sao ở đỉnh logo
      if (this.glintSprite && !this.pal.light && !r.exiting) {
        const gs = H * 0.075 * (0.75 + 0.25 * Math.sin(r.t * 3.1)) * clamp(r.t * 2, 0, 1);
        const gx = this.W / 2 + Math.sin(rot) * S * 0.43;
        const gy = r.y + bob - S * 0.43;
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        ctx.globalAlpha = 0.95;
        ctx.translate(gx, gy);
        ctx.rotate(r.t * 0.4);
        ctx.drawImage(this.glintSprite, -gs, -gs, gs * 2, gs * 2);
        ctx.restore();
      }

      ctx.save();
      ctx.translate(this.W / 2, r.y + bob);
      ctx.rotate(rot * 0.6);
      ctx.font = `${Math.round(H * 0.064)}px ${DISPLAY_FONT}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "alphabetic";
      ctx.fillStyle = this.pal.ink;
      ctx.fillText(this.label, 0, S * 0.5 + H * 0.085);
      ctx.restore();
    }

    _present() {
      const fx = this.fx;
      const gl = this.gl;
      if (!gl) {
        // Fallback 2D: chỉ có chớp và mờ dần
        const ctx = this.ctx;
        ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        if (fx.flash > 0.01) {
          ctx.globalAlpha = fx.flash;
          ctx.fillStyle = this.pal.ink;
          ctx.fillRect(0, 0, this.W, this.H);
        }
        if (fx.fade > 0.01) {
          ctx.globalAlpha = fx.fade;
          ctx.fillStyle = this.pal.bg;
          ctx.fillRect(0, 0, this.W, this.H);
        }
        ctx.globalAlpha = 1;
        return;
      }
      const u = this.u;
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, this.scene);
      gl.uniform2f(u.uRes, this.scene.width, this.scene.height);
      gl.uniform1f(u.uTime, this.time);
      if (fx.shock) {
        const s = fx.shock;
        gl.uniform4f(u.uShock, s.x / this.W, 1 - s.y / this.H, s.t * 1.15, Math.pow(1 - s.t / 1.25, 1.5));
      } else {
        gl.uniform4f(u.uShock, 0, 0, 0, 0);
      }
      const charging = this._charging();
      gl.uniform1f(u.uAberr, fx.aberr);
      gl.uniform1f(u.uGlow, this.pal.light || this.quality < 2 ? 0 : fx.glow);
      gl.uniform1f(u.uFlash, clamp(fx.flash, 0, 1));
      const fc = this.pal.light ? this.pal.accentRgb : this.pal.inkRgb;
      gl.uniform3f(u.uFlashCol, fc[0] / 255, fc[1] / 255, fc[2] / 255);
      gl.uniform1f(u.uInvert, fx.invertT > 0 ? 1 : 0);
      gl.uniform1f(u.uGrain, this.pal.light ? 0.055 : 0.05);
      gl.uniform1f(u.uVig, (this.pal.light ? 0.22 : 0.5) + charging * 0.3);
      gl.uniform1f(u.uFade, clamp(fx.fade, 0, 1));
      const b = this.pal.bgRgb;
      gl.uniform3f(u.uBg, b[0] / 255, b[1] / 255, b[2] / 255);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
  }

  window.GravityStage = GravityStage;
})();

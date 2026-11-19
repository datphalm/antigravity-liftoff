/**
 * Antigravity Launcher v3 — Audio
 * Toàn bộ tiếng được tổng hợp bằng Web Audio (không cần file), trừ giọng đọc.
 * Ngôn ngữ âm thanh bám theo vật lý: chữ rơi = tiếng uỵch theo lực va chạm,
 * nạp = tiếng gầm dâng dần, cất cánh = hút gió (khoảng lặng) rồi nổ.
 */
class AntigravityAudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.bus = null;
    this.reverb = null;
    this.analyser = null;
    this.fft = null;
    this.noiseBuf = null;
    this.voiceBuffers = new Map();
    this.currentVoice = null;

    this.volume = 0.85;
    this.muted = false;
    this.voiceLang = "en";
    this.ambientEnabled = true;

    this.ambient = null;
    this.heartbeat = null;
    this.riser = null;
  }

  // ------------------------------------------------------------- setup
  init() {
    if (this.ctx) {
      if (this.ctx.state === "suspended") this.ctx.resume().catch(() => {});
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());

    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.volume;

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -12;
    comp.knee.value = 10;
    comp.ratio.value = 8;
    comp.attack.value = 0.003;
    comp.release.value = 0.25;

    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 256;
    this.analyser.smoothingTimeConstant = 0.8;
    this.fft = new Uint8Array(this.analyser.frequencyBinCount);

    this.bus = ctx.createGain();
    this.bus.gain.value = 1;

    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this._impulse(2.8, 2.4);
    const wet = ctx.createGain();
    wet.gain.value = 0.42;

    this.bus.connect(this.master);
    this.reverb.connect(wet);
    wet.connect(this.master);
    this.master.connect(comp);
    comp.connect(this.analyser);
    this.analyser.connect(ctx.destination);

    const len = ctx.sampleRate * 2;
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    const unlock = () => {
      if (this.ctx && this.ctx.state === "suspended") this.ctx.resume().catch(() => {});
    };
    window.addEventListener("pointerdown", unlock, { passive: true });
    window.addEventListener("keydown", unlock, { passive: true });

    this._preloadVoices();
  }

  _impulse(duration, decay) {
    const rate = this.ctx.sampleRate;
    const len = Math.floor(rate * duration);
    const buf = this.ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay) * 0.5;
    }
    return buf;
  }

  get ready() {
    return Boolean(this.ctx && this.ctx.state === "running");
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, Number(v) || 0));
    this._applyGain();
  }

  setMuted(m) {
    this.muted = Boolean(m);
    this._applyGain();
  }

  _applyGain() {
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(this.muted ? 0 : this.volume, this.ctx.currentTime, 0.04);
    }
  }

  setVoiceLang(lang) {
    this.voiceLang = lang;
  }

  setAmbient(enabled) {
    this.ambientEnabled = Boolean(enabled);
    if (!this.ambientEnabled) this.stopAmbient();
  }

  // ---------------------------------------------------------- building blocks
  _now() {
    return this.ctx.currentTime;
  }

  _out(node, { pan = 0, wet = 0 } = {}) {
    let tail = node;
    if (pan && this.ctx.createStereoPanner) {
      const p = this.ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, pan));
      node.connect(p);
      tail = p;
    }
    tail.connect(this.bus);
    if (wet > 0) {
      const s = this.ctx.createGain();
      s.gain.value = wet;
      tail.connect(s);
      s.connect(this.reverb);
    }
    return tail;
  }

  _osc(type, f0, f1, t, dur, peak, { attack = 0.004, curve = "exp", pan = 0, wet = 0, filter = null } = {}) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 && f1 !== f0) {
      if (curve === "exp") o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
      else o.frequency.linearRampToValueAtTime(f1, t + dur);
    }
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    let head = o;
    if (filter) {
      const f = ctx.createBiquadFilter();
      f.type = filter.type;
      f.Q.value = filter.q ?? 0.8;
      f.frequency.setValueAtTime(filter.f0, t);
      if (filter.f1) f.frequency.exponentialRampToValueAtTime(filter.f1, t + (filter.dur ?? dur));
      o.connect(f);
      head = f;
    }
    head.connect(g);
    this._out(g, { pan, wet });
    o.start(t);
    o.stop(t + dur + 0.05);
    return o;
  }

  _noise(t, dur, peak, { type = "bandpass", f0 = 1000, f1 = null, q = 0.9, attack = 0.005, pan = 0, wet = 0, shape = "exp" } = {}) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(f0, t);
    if (f1) f.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    if (shape === "swell") {
      g.gain.linearRampToValueAtTime(peak, t + dur * 0.8);
      g.gain.linearRampToValueAtTime(0.0001, t + dur);
    } else {
      g.gain.linearRampToValueAtTime(peak, t + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    }
    src.connect(f);
    f.connect(g);
    this._out(g, { pan, wet });
    src.start(t, Math.random() * 1.5);
    src.stop(t + dur + 0.05);
  }

  // ------------------------------------------------------------- physical
  /** Tiếng chữ chạm đất. strength 0..1, pan -1..1 */
  thud(strength, pan = 0) {
    if (!this.ready) return;
    const s = Math.max(0, Math.min(1, strength));
    if (s < 0.025) return;
    const t = this._now();
    const det = 0.9 + Math.random() * 0.2;
    const p = pan * 0.55;
    this._osc("sine", 150 * det, 38, t, 0.2 + s * 0.28, 0.75 * Math.pow(s, 0.75), { attack: 0.003, pan: p });
    this._osc("triangle", 105 * det, 58, t, 0.09, 0.28 * s, { attack: 0.002, pan: p });
    this._noise(t, 0.05 + s * 0.05, 0.42 * s, { type: "lowpass", f0: 1400 + s * 1800, q: 0.6, attack: 0.002, pan: p, wet: 0.08 });
  }

  /** Đường sàn được kẻ ra lúc mở màn */
  zip() {
    if (!this.ready) return;
    const t = this._now();
    this._noise(t, 0.38, 0.12, { type: "bandpass", f0: 900, f1: 7000, q: 2.2, shape: "swell", wet: 0.3 });
    this._osc("sine", 1800, 3600, t + 0.02, 0.32, 0.02, { attack: 0.2, wet: 0.4 });
  }

  tick(i = 0) {
    if (!this.ready) return;
    const t = this._now();
    const f = [880, 1174.66, 1567.98, 1318.51][i % 4];
    this._osc("sine", f, f, t, 0.12, 0.07, { attack: 0.003, wet: 0.25 });
    this._osc("sine", f * 2, f * 2, t, 0.05, 0.02, { attack: 0.002 });
  }

  hover() {
    if (!this.ready) return;
    this._osc("sine", 2600, 2900, this._now(), 0.03, 0.012, { attack: 0.002 });
  }

  click() {
    if (!this.ready) return;
    const t = this._now();
    this._osc("sine", 1500, 700, t, 0.05, 0.06, { attack: 0.002 });
    this._noise(t, 0.02, 0.05, { type: "highpass", f0: 3000, attack: 0.001 });
  }

  flick() {
    if (!this.ready) return;
    const t = this._now();
    this._osc("sine", 260, 980, t, 0.16, 0.09, { attack: 0.004, wet: 0.2 });
    this._noise(t, 0.2, 0.06, { type: "bandpass", f0: 500, f1: 4000, q: 1.4, wet: 0.2 });
  }

  /** Mỗi chữ số PIN đúng: cơ khí, cao dần */
  clunk(n) {
    if (!this.ready) return;
    const t = this._now();
    const f = 196 * Math.pow(2, (n * 3) / 12);
    this._osc("square", f, f * 0.98, t, 0.09, 0.05, { attack: 0.002, filter: { type: "lowpass", f0: 1800, q: 1 } });
    this._osc("sine", f * 2, f * 2, t + 0.01, 0.3, 0.05, { attack: 0.003, wet: 0.35 });
    this._noise(t, 0.03, 0.12, { type: "bandpass", f0: 3200, q: 1.5, attack: 0.001 });
  }

  /** PIN sai: cả khối đập xuống */
  slam() {
    if (!this.ready) return;
    const t = this._now();
    this.thud(1, 0);
    this._osc("sawtooth", 58, 52, t, 0.32, 0.18, { attack: 0.004, filter: { type: "lowpass", f0: 380, q: 2 } });
    this._osc("sawtooth", 61.5, 55, t, 0.32, 0.14, { attack: 0.004, filter: { type: "lowpass", f0: 380, q: 2 } });
  }

  // ---------------------------------------------------------------- riser
  _startRiser() {
    if (!this.ready || this.riser) return;
    const ctx = this.ctx;
    const t = this._now();

    const trem = ctx.createGain();
    trem.gain.value = 1;
    const lfo = ctx.createOscillator();
    const lfoAmt = ctx.createGain();
    lfo.frequency.value = 3;
    lfoAmt.gain.value = 0.15;
    lfo.connect(lfoAmt);
    lfoAmt.connect(trem.gain);

    const noise = ctx.createBufferSource();
    noise.buffer = this.noiseBuf;
    noise.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.Q.value = 0.9;
    bp.frequency.value = 250;
    const gN = ctx.createGain();
    gN.gain.value = 0.0001;
    noise.connect(bp);
    bp.connect(gN);
    gN.connect(trem);

    const oA = ctx.createOscillator();
    const oB = ctx.createOscillator();
    oA.type = "sawtooth";
    oB.type = "sawtooth";
    oA.frequency.value = 55;
    oB.frequency.value = 55 * 1.498;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.Q.value = 5;
    lp.frequency.value = 160;
    const gO = ctx.createGain();
    gO.gain.value = 0.0001;
    oA.connect(lp);
    oB.connect(lp);
    lp.connect(gO);
    gO.connect(trem);

    const sub = ctx.createOscillator();
    sub.type = "sine";
    sub.frequency.value = 41;
    const gS = ctx.createGain();
    gS.gain.value = 0.0001;
    sub.connect(gS);
    gS.connect(trem);

    this._out(trem, { wet: 0.18 });
    [lfo, noise, oA, oB, sub].forEach((n) => n.start(t));
    this.riser = { trem, lfo, lfoAmt, noise, bp, gN, oA, oB, lp, gO, sub, gS };
  }

  /** c: 0..1 — gọi mỗi khung hình khi đang nạp */
  updateRiser(c) {
    if (!this.ready) return;
    if (!this.riser) this._startRiser();
    const r = this.riser;
    if (!r) return;
    const t = this._now();
    const tc = 0.03;
    r.bp.frequency.setTargetAtTime(250 + Math.pow(c, 1.6) * 5600, t, tc);
    r.gN.gain.setTargetAtTime(0.015 + Math.pow(c, 1.5) * 0.22, t, tc);
    const f = 55 * (1 + c * 1.7);
    r.oA.frequency.setTargetAtTime(f, t, tc);
    r.oB.frequency.setTargetAtTime(f * 1.498, t, tc);
    r.lp.frequency.setTargetAtTime(160 + c * c * 3400, t, tc);
    r.gO.gain.setTargetAtTime(Math.pow(c, 1.2) * 0.11, t, tc);
    r.gS.gain.setTargetAtTime(0.14 * c, t, tc);
    r.lfo.frequency.setTargetAtTime(3 + c * 18, t, tc);
    r.lfoAmt.gain.setTargetAtTime(0.12 + c * 0.38, t, tc);
  }

  stopRiser(fast = false) {
    const r = this.riser;
    if (!r || !this.ctx) return;
    this.riser = null;
    const t = this._now();
    const d = fast ? 0.04 : 0.25;
    [r.gN, r.gO, r.gS].forEach((g) => {
      g.gain.cancelScheduledValues(t);
      g.gain.setTargetAtTime(0.0001, t, d / 3);
    });
    [r.lfo, r.noise, r.oA, r.oB, r.sub].forEach((n) => {
      try {
        n.stop(t + d + 0.1);
      } catch {}
    });
  }

  // --------------------------------------------------------------- liftoff
  /** Khoảng lặng hút gió ngay trước cú nổ */
  suck() {
    if (!this.ready) return;
    const t = this._now();
    this.bus.gain.cancelScheduledValues(t);
    this.bus.gain.setValueAtTime(this.bus.gain.value, t);
    this.bus.gain.linearRampToValueAtTime(0.1, t + 0.085);
    this._noise(t, 0.11, 0.3, { type: "highpass", f0: 600, f1: 9000, q: 0.7, shape: "swell" });
  }

  boom() {
    if (!this.ready) return;
    const t = this._now();
    this.bus.gain.cancelScheduledValues(t);
    this.bus.gain.setValueAtTime(1, t);

    // vết nứt + thân nổ
    this._noise(t, 0.05, 0.6, { type: "highpass", f0: 1800, attack: 0.001 });
    this._noise(t, 1.6, 0.55, { type: "lowpass", f0: 9000, f1: 220, q: 0.5, attack: 0.003, wet: 0.5 });
    // sub rơi tự do
    this._osc("sine", 82, 22, t, 2.4, 1.0, { attack: 0.004 });
    this._osc("sine", 164, 44, t, 0.7, 0.35, { attack: 0.003 });
    // vút lên
    this._noise(t + 0.02, 0.9, 0.28, { type: "bandpass", f0: 280, f1: 7600, q: 1.3, shape: "swell", wet: 0.45 });
    this._osc("sine", 220, 1760, t + 0.03, 1.1, 0.05, { attack: 0.05, wet: 0.5 });
    // ánh sao: chuông cao rải rác
    [2637.02, 3135.96, 3951.07, 5274.04, 3520].forEach((f, i) => {
      this._osc("sine", f, f, t + 0.06 + i * 0.07 + Math.random() * 0.03, 0.9, 0.022, { attack: 0.002, wet: 0.8, pan: (Math.random() - 0.5) * 1.4 });
    });
    // hợp âm sáng (D add9)
    [146.83, 220, 293.66, 369.99, 440, 659.25].forEach((f, i) => {
      const det = 1 + (Math.random() - 0.5) * 0.008;
      this._osc("sawtooth", f * det, f * det, t, 2.1, 0.04 / (1 + i * 0.15), {
        attack: 0.006,
        wet: 0.6,
        filter: { type: "lowpass", f0: 7000, f1: 700, q: 0.7, dur: 1.6 },
      });
    });
  }

  /** Một nét mực chém qua màn hình */
  slash(pan = 0) {
    if (!this.ready) return;
    const t = this._now();
    this._noise(t, 0.16, 0.22, { type: "bandpass", f0: 1400, f1: 7800, q: 1.6, attack: 0.004, pan: pan * 0.8, wet: 0.25 });
    this._noise(t, 0.05, 0.12, { type: "highpass", f0: 5000, attack: 0.001, pan: pan * 0.8 });
  }

  /** Lúc logo lơ lửng: một lớp không khí cao, mỏng */
  pad() {
    if (!this.ready) return;
    const t = this._now();
    [587.33, 880, 1318.51, 1760].forEach((f, i) => {
      const ctx = this.ctx;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.frequency.value = f * (1 + (i - 1.5) * 0.002);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.022 / (1 + i * 0.3), t + 0.5);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 2.8);
      o.connect(g);
      this._out(g, { wet: 0.85 });
      o.start(t);
      o.stop(t + 2.9);
    });
  }

  /** Đóng launcher: mọi thứ rơi xuống */
  fall() {
    if (!this.ready) return;
    const t = this._now();
    this._osc("sine", 520, 48, t, 0.6, 0.12, { attack: 0.01, wet: 0.2 });
    this._noise(t, 0.55, 0.12, { type: "bandpass", f0: 3000, f1: 200, q: 1, shape: "swell" });
  }

  // --------------------------------------------------------------- ambient
  startAmbient() {
    if (!this.ready || this.ambient || !this.ambientEnabled) return;
    const ctx = this.ctx;
    const t = this._now();
    const out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, t);
    out.gain.linearRampToValueAtTime(0.055, t + 2.2);

    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 260;
    lp.Q.value = 1.2;
    const lfo = ctx.createOscillator();
    const lfoG = ctx.createGain();
    lfo.frequency.value = 0.07;
    lfoG.gain.value = 90;
    lfo.connect(lfoG);
    lfoG.connect(lp.frequency);

    const oscs = [
      ["sine", 55],
      ["sine", 82.41],
      ["triangle", 110.3],
    ].map(([type, f]) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f;
      o.connect(lp);
      return o;
    });
    lp.connect(out);
    this._out(out, { wet: 0.3 });
    [lfo, ...oscs].forEach((o) => o.start(t));
    this.ambient = { out, nodes: [lfo, ...oscs] };

    // nhịp tim rất nhẹ
    let beat = 0;
    this.heartbeat = setInterval(() => {
      if (!this.ready || this.muted) return;
      const n = this._now();
      const k = beat++ % 2 === 0 ? 1 : 0;
      if (!k) return;
      this._osc("sine", 72, 40, n, 0.16, 0.07, { attack: 0.004 });
      this._osc("sine", 68, 38, n + 0.2, 0.14, 0.045, { attack: 0.004 });
    }, 900);
  }

  stopAmbient() {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    const a = this.ambient;
    if (!a || !this.ctx) return;
    this.ambient = null;
    const t = this._now();
    a.out.gain.cancelScheduledValues(t);
    a.out.gain.setTargetAtTime(0.0001, t, 0.15);
    a.nodes.forEach((n) => {
      try {
        n.stop(t + 0.8);
      } catch {}
    });
  }

  // ---------------------------------------------------------------- voice
  async _preloadVoices() {
    const jobs = [];
    ["en", "vi"].forEach((lang) =>
      ["intro", "welcome"].forEach((k) => jobs.push(this._loadVoice(`${lang}_${k}`)))
    );
    await Promise.allSettled(jobs);
  }

  async _loadVoice(id) {
    if (this.voiceBuffers.has(id) || !this.ctx) return;
    try {
      const resp = await fetch(`assets/audio/${id}.mp3`);
      if (!resp.ok) return;
      const buf = await this.ctx.decodeAudioData(await resp.arrayBuffer());
      this.voiceBuffers.set(id, buf);
    } catch {}
  }

  async playVoice(key) {
    if (this.voiceLang === "off" || !this.ctx) return;
    const id = `${this.voiceLang}_${key}`;
    if (!this.voiceBuffers.has(id)) await this._loadVoice(id);
    const buf = this.voiceBuffers.get(id);
    if (!buf || !this.ready) return;
    if (this.currentVoice) {
      try {
        this.currentVoice.stop();
      } catch {}
    }
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 110;
    const pres = ctx.createBiquadFilter();
    pres.type = "peaking";
    pres.frequency.value = 3000;
    pres.Q.value = 1;
    pres.gain.value = 3;
    const g = ctx.createGain();
    g.gain.value = 0.95;
    src.connect(hp);
    hp.connect(pres);
    pres.connect(g);
    this._out(g, { wet: 0.22 });
    src.start();
    this.currentVoice = src;
  }

  // ------------------------------------------------------- ghi lại (demo)
  /** Ghi đúng tín hiệu launcher phát ra (sau compressor) để ghép vào video demo. */
  startCapture() {
    if (!this.ctx || this.capture) return;
    const node = this.ctx.createScriptProcessor(4096, 2, 2);
    const L = [];
    const R = [];
    node.onaudioprocess = (e) => {
      L.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      R.push(new Float32Array(e.inputBuffer.getChannelData(1)));
    };
    const sink = this.ctx.createGain();
    sink.gain.value = 0;
    this.analyser.connect(node);
    node.connect(sink);
    sink.connect(this.ctx.destination);
    this.capture = { node, L, R, startEpoch: Date.now(), rate: this.ctx.sampleRate };
  }

  /** Dừng ghi, trả về WAV 16-bit stereo dạng base64 + thời điểm bắt đầu (epoch ms). */
  stopCapture() {
    const c = this.capture;
    if (!c) return null;
    this.capture = null;
    try {
      this.analyser.disconnect(c.node);
    } catch {}
    const n = c.L.reduce((a, b) => a + b.length, 0);
    const buf = new ArrayBuffer(44 + n * 4);
    const v = new DataView(buf);
    const str = (o, s) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
    str(0, "RIFF");
    v.setUint32(4, 36 + n * 4, true);
    str(8, "WAVEfmt ");
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, 2, true);
    v.setUint32(24, c.rate, true);
    v.setUint32(28, c.rate * 4, true);
    v.setUint16(32, 4, true);
    v.setUint16(34, 16, true);
    str(36, "data");
    v.setUint32(40, n * 4, true);
    let o = 44;
    for (let k = 0; k < c.L.length; k++) {
      const l = c.L[k];
      const r = c.R[k];
      for (let i = 0; i < l.length; i++) {
        v.setInt16(o, Math.max(-1, Math.min(1, l[i])) * 32767, true);
        v.setInt16(o + 2, Math.max(-1, Math.min(1, r[i])) * 32767, true);
        o += 4;
      }
    }
    const bytes = new Uint8Array(buf);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return { b64: btoa(bin), startEpoch: c.startEpoch, rate: c.rate };
  }

  // --------------------------------------------------------------- meter
  getEnergy() {
    if (!this.analyser || this.muted) return 0;
    this.analyser.getByteFrequencyData(this.fft);
    let sum = 0;
    for (let i = 0; i < 20; i++) sum += this.fft[i];
    return sum / (20 * 255);
  }
}

window.AntigravityAudioEngine = AntigravityAudioEngine;

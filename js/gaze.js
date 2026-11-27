/*
 * GazeRead – двигател за проследяване на погледа
 *
 * Вместо WebGazer използва MediaPipe Face Landmarker, който намира 478 точки от лицето,
 * включително центъра на ирисите. От тях смятаме:
 *   • къде е ирисът спрямо ъглите и клепачите на окото (по-устойчиво от суровите пиксели),
 *   • накъде е обърната главата и колко е далеч.
 * После с ридж регресия (обучена при калибрирането) превръщаме тези признаци в точка на екрана
 * и я изглаждаме с „One Euro“ филтър. Кликовете върху думи допълнително дообучават модела.
 */
const MP_VER = '0.10.14';
const MP_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VER}/vision_bundle.mjs`;
const WASM_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VER}/wasm`;
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

// индекси на точките от лицето
const L_EYE = { a: 33, b: 133, up: 159, low: 145, iris: 468 };
const R_EYE = { a: 362, b: 263, up: 386, low: 374, iris: 473 };

// ---------- One Euro филтър: гладко при покой, бързо при движение ----------
class OneEuro {
  constructor(minCutoff = 0.4, beta = 0.004, dCutoff = 1) { Object.assign(this, { minCutoff, beta, dCutoff }); this.reset(); }
  reset() { this.x = null; this.dx = 0; this.t = null; }
  static alpha(cutoff, dt) { const tau = 1 / (2 * Math.PI * cutoff); return 1 / (1 + tau / dt); }
  filter(v, t) {
    if (this.x === null) { this.x = v; this.t = t; return v; }
    const dt = Math.max(1e-3, (t - this.t) / 1000); this.t = t;
    const dv = (v - this.x) / dt;
    this.dx += OneEuro.alpha(this.dCutoff, dt) * (dv - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += OneEuro.alpha(cutoff, dt) * (v - this.x);
    return this.x;
  }
}

// ---------- линейна алгебра ----------
function solve(A, b) {               // Гаусова елиминация с избор на главен елемент
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const k = M[r][c] / d;
      if (k) for (let j = c; j <= n; j++) M[r][j] -= k * M[c][j];
    }
  }
  return M.map((r, i) => r[n] / (r[i] || 1e-12));
}

function ridge(X, ys, w, lambda) {  // връща тегла за всеки изход в ys
  const d = X[0].length;
  const A = Array.from({ length: d }, () => new Array(d).fill(0));
  const bs = ys.map(() => new Array(d).fill(0));
  for (let i = 0; i < X.length; i++) {
    const xi = X[i], wi = w[i];
    for (let a = 0; a < d; a++) {
      const v = xi[a] * wi;
      if (!v) continue;
      for (let b = a; b < d; b++) A[a][b] += v * xi[b];
      for (let k = 0; k < ys.length; k++) bs[k][a] += v * ys[k][i];
    }
  }
  for (let a = 0; a < d; a++) { for (let b = 0; b < a; b++) A[a][b] = A[b][a]; if (a < d - 1) A[a][a] += lambda; } // последният е свободният член
  return bs.map((b) => solve(A, b));
}

const median = (arr) => { const s = [...arr].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// ---------- двигателят ----------
class GazeEngine {
  constructor() {
    this.video = null; this.stream = null; this.landmarker = null;
    this.running = false; this.model = null;
    this.samples = [];           // {f, x, y, w, g}
    this.recent = [];            // последните признаци (за кликове)
    this.listeners = { gaze: [], status: [] };
    this.fx = new OneEuro(); this.fy = new OneEuro();
    this.openBase = null;
    this.status = { face: false, eyeWidth: 0, faceScale: 0, distanceRatio: null, distanceChanged: false, brightness: null, blink: false, fps: 0 };
    this._referenceEyeWidth = null;
    this._referenceFaceHeight = null;
    this._distanceSamples = [];
    this._frames = 0; this._fpsT = performance.now();
    this._canvas = document.createElement('canvas'); this._canvas.width = 32; this._canvas.height = 24;
  }

  on(evt, cb) { this.listeners[evt].push(cb); }
  emit(evt, ...a) { for (const cb of this.listeners[evt]) cb(...a); }

  /** Отваря камерата; при неуспех опитва с все по-прости настройки (някои лаптопи не приемат 1280×720/30fps). */
  static async openCamera(deviceId) {
    const dev = deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'user' };
    // по-висока резолюция → повече пиксели за очите, когато човекът седи по-далеч от екрана
    const tries = [
      { ...dev, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
      { ...dev, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
      { ...dev, width: { ideal: 640 }, height: { ideal: 480 } },
      deviceId ? { deviceId: { exact: deviceId } } : true,
      true,
    ];
    let last = null;
    for (const video of tries) {
      try { return await navigator.mediaDevices.getUserMedia({ video, audio: false }); } catch (e) {
        last = e;
        if (e.name === 'NotAllowedError' || e.name === 'SecurityError') break; // забрана – няма смисъл да опитваме пак
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    if (last) last.stage = 'camera';
    throw last;
  }

  async start(video, deviceId) {
    this.video = video;
    const modP = import(MP_URL).catch((e) => { e.stage = 'model'; throw e; });
    modP.catch(() => {});
    const stream = await GazeEngine.openCamera(deviceId);
    this.stream = stream;
    try {
      const { FaceLandmarker, FilesetResolver } = await modP;
      video.srcObject = stream;
      video.muted = true; video.playsInline = true;
      await video.play().catch(() => {});
      if (!this.landmarker) {
        const fs = await FilesetResolver.forVisionTasks(WASM_URL);
        const opts = (delegate) => ({
          baseOptions: { modelAssetPath: MODEL_URL, delegate },
          runningMode: 'VIDEO', numFaces: 1,
          // по-ниски прагове: малко (далечно) лице все пак се намира и не се „губи“
          minFaceDetectionConfidence: 0.3, minFacePresenceConfidence: 0.3, minTrackingConfidence: 0.3,
          outputFacialTransformationMatrixes: true, outputFaceBlendshapes: false,
        });
        try { this.landmarker = await FaceLandmarker.createFromOptions(fs, opts('GPU')); }
        catch (e) { this.landmarker = await FaceLandmarker.createFromOptions(fs, opts('CPU')); }
      }
    } catch (e) {
      if (!e.stage) e.stage = 'model';
      this.stop();
      throw e;
    }
    this.running = true;
    this._lastVideoTime = -1;
    this._loop();
  }

  stop() {
    this.running = false;
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.video) this.video.srcObject = null;
  }

  _loop() {
    if (!this.running) return;
    const v = this.video;
    if (v.readyState >= 2 && v.currentTime !== this._lastVideoTime) {
      this._lastVideoTime = v.currentTime;
      const now = performance.now();
      let res = null;
      try { res = this.landmarker.detectForVideo(v, now); } catch (e) { /* пропусни кадъра */ }
      this._process(res, now);
    }
    requestAnimationFrame(() => this._loop());
  }

  _brightness() {
    const c = this._canvas.getContext('2d', { willReadFrequently: true });
    c.drawImage(this.video, 0, 0, 32, 24);
    const d = c.getImageData(0, 0, 32, 24).data;
    let s = 0; for (let i = 0; i < d.length; i += 4) s += d[i] * .299 + d[i + 1] * .587 + d[i + 2] * .114;
    return s / (d.length / 4);
  }

  _process(res, now) {
    this._frames++;
    if (now - this._fpsT > 1000) {
      this.status.fps = Math.round(this._frames * 1000 / (now - this._fpsT));
      this._frames = 0; this._fpsT = now;
      this.status.brightness = this._brightness();
    }
    const lm = res && res.faceLandmarks && res.faceLandmarks[0];
    this.status.face = !!lm;
    if (!lm) { this.status.blink = false; this.emit('status', this.status); return; }
    const W = this.video.videoWidth, H = this.video.videoHeight;
    const P = (i) => ({ x: lm[i].x * W, y: lm[i].y * H });
    const mat = res.facialTransformationMatrixes && res.facialTransformationMatrixes[0] && res.facialTransformationMatrixes[0].data;
    const f = this._features(P, mat, W, H);
    this.status.eyeWidth = f.eyeW;
    this.status.faceScale = f.faceScale;
    this._distanceSamples.push({ eyeW: f.eyeW, faceH: f.faceH, t: now });
    while (this._distanceSamples.length && now - this._distanceSamples[0].t > 3000) this._distanceSamples.shift();
    if (this._referenceEyeWidth) {
      // медиана за последните ~0.5 s: при далечно лице ширината на окото „трепти“ от кадър на кадър
      const recentW = median(this._distanceSamples.filter((s) => now - s.t <= 500).map((s) => s.eyeW));
      this.status.distanceRatio = recentW / this._referenceEyeWidth;
      this.status.distanceChanged = this.status.distanceRatio < 0.72 || this.status.distanceRatio > 1.38;
    } else {
      this.status.distanceRatio = null;
      this.status.distanceChanged = false;
    }
    // мигане: клепачите са много по-затворени от обичайното
    if (this.openBase === null) this.openBase = f.open;
    this.status.blink = f.open < this.openBase * 0.72;
    if (!this.status.blink) this.openBase += (f.open - this.openBase) * 0.02;
    this.emit('status', this.status);
    // при мигане и ~180 ms след него очите още не са на място → пропускаме кадрите
    if (this.status.blink) { this._blinkUntil = now + 180; this._raw = []; return; }
    if (now < (this._blinkUntil || 0)) return;
    this.recent.push({ f: f.vec, t: now });
    while (this.recent.length && now - this.recent[0].t > 3000) this.recent.shift();
    if (this.model) {
      // медиана от последните кадри маха единичните „скокове“;
      // когато лицето е далеч (малки очи в кадъра), шумът е по-голям → гледаме повече кадри
      const far = f.eyeW / (W || 1) < 0.022;
      const win = far ? 9 : 5;
      const cutoff = far ? 0.25 : 0.4;
      if (this.fx.minCutoff !== cutoff) { this.fx.minCutoff = cutoff; this.fy.minCutoff = cutoff; }
      this._raw = this._raw || [];
      this._raw.push(this._predict(f.vec));
      while (this._raw.length > win) this._raw.shift();
      const x = median(this._raw.map((p) => p[0])), y = median(this._raw.map((p) => p[1]));
      const sx = this.fx.filter(x, now), sy = this.fy.filter(y, now);
      this.emit('gaze', sx, sy, { rawX: x, rawY: y });
    }
  }

  _features(P, mat, W, H) {
    const eye = (e) => {
      const A = P(e.a), B = P(e.b), U = P(e.up), D = P(e.low), I = P(e.iris);
      const ox = (A.x + B.x) / 2, oy = (A.y + B.y) / 2;
      let ux = B.x - A.x, uy = B.y - A.y; const w = Math.hypot(ux, uy) || 1; ux /= w; uy /= w;
      const vx = -uy, vy = ux;
      const dx = I.x - ox, dy = I.y - oy;
      const lid = (D.x - U.x) * vx + (D.y - U.y) * vy || 1e-3;
      return {
        x: (dx * ux + dy * uy) / w,
        y: (dx * vx + dy * vy) / w,
        y2: ((I.x - U.x) * vx + (I.y - U.y) * vy) / lid,  // ирисът между горния и долния клепач
        open: Math.abs(lid) / w, w,
      };
    };
    const l = eye(L_EYE), r = eye(R_EYE);
    const ex = (l.x + r.x) / 2, ey = (l.y + r.y) / 2, ey2 = (l.y2 + r.y2) / 2;
    const nose = P(1);
    const eyeW = (l.w + r.w) / 2;
    const top = P(10), chin = P(152), left = P(234), right = P(454);
    const faceH = Math.max(1, Math.abs(chin.y - top.y));
    const faceW = Math.max(1, Math.abs(right.x - left.x));
    const faceScale = eyeW / faceW;
    const normalizedEyeW = eyeW / (W || 1);
    const normalizedFaceH = faceH / (H || 1);
    const normalizedFaceW = faceW / (W || 1);
    let head;
    if (mat) head = [mat[8], mat[9], mat[12], mat[13], mat[14]];       // посока на лицето + позиция (см)
    else { head = [0, 0, nose.x / eyeW, nose.y / eyeW, 1 / eyeW]; }
    // и двете очи поотделно (едното често се вижда по-добре) + средни стойности и квадрати за извивката
    const vec = [l.x, l.y, r.x, r.y, l.y2, r.y2, ex * ex, ey * ey, ex * ey, ey2 * ey2,
      ...head, ex * head[0], ey * head[1], ex * head[2], ey * head[3],
      normalizedEyeW, normalizedFaceH, normalizedFaceW, faceScale, 1];
    return { vec, open: (l.open + r.open) / 2, eyeW, faceH, faceScale };
  }

  // ---------- обучение ----------
  /** Събира признаци за ms милисекунди (докато потребителят гледа една точка). */
  collect(ms) {
    return new Promise((resolve) => {
      const out = [];
      const t0 = performance.now();
      const tick = () => {
        const last = this.recent[this.recent.length - 1];
        if (last && last.t > t0 && (!out.length || out[out.length - 1] !== last.f)) out.push(last.f);
        if (performance.now() - t0 < ms) requestAnimationFrame(tick); else resolve(out);
      };
      tick();
    });
  }

  /** Добавя проби за известна точка на екрана; отхвърля най-отдалечените (погледът е избягал). */
  addPoint(feats, x, y, group, weight = 1) {
    if (feats.length < 4) return 0;
    const d = feats[0].length;
    const med = Array.from({ length: d }, (_, j) => median(feats.map((f) => f[j])));
    const dist = feats.map((f) => Math.hypot(f[0] - med[0], f[1] - med[1], f[2] - med[2] * 0.3));
    const cut = median(dist) * 2.5 + 1e-6;
    let n = 0;
    feats.forEach((f, i) => { if (dist[i] <= cut) { this.samples.push({ f, x, y, w: weight, g: group }); n++; } });
    return n;
  }

  /** Добавя проба от клик върху дума (използва погледа точно преди клика). */
  addClick(x, y) { return this.addLabel(x, y, 0, 350, 1.5); }

  /**
   * Учене по време на четене: знаем, че човекът е гледал точка (x, y) в интервала
   * [сега − fromMs, сега − toMs] (напр. задържал е поглед на дума и после е натиснал Shift).
   */
  addLabel(x, y, toMs, fromMs, weight = 1.2) {
    const now = performance.now();
    const feats = this.recent.filter((r) => now - r.t <= fromMs && now - r.t >= toMs).map((r) => r.f);
    if (feats.length < 3 || !this.model) return false;
    // ако е много далеч от предвиденото, вероятно човекът не е гледал там
    const p = this.predictMany(feats);
    if (Math.hypot(p[0] - x, p[1] - y) > Math.max(innerWidth, innerHeight) * 0.3) return false;
    this.addPoint(feats.slice(-25), x, y, 'live' + (this._liveN = (this._liveN || 0) + 1), weight);
    const live = this.samples.filter((s) => String(s.g).startsWith('live'));
    if (live.length > 400) { const drop = new Set(live.slice(0, live.length - 400)); this.samples = this.samples.filter((s) => !drop.has(s)); }
    this.fit(false);
    this.learned = (this.learned || 0) + 1;
    return true;
  }

  clear() { this.samples = []; this.model = null; this.fx.reset(); this.fy.reset(); this._raw = []; }

  // ---------- запазване между сесиите ----------
  static VERSION = 4;   // сменя се, ако признаците се променят → старите данни се игнорират

  /** Запомня сегашното разстояние като еталон за калибриране и четене. */
  setDistanceReference() {
    if (!this._distanceSamples.length) return false;
    this._referenceEyeWidth = median(this._distanceSamples.map((s) => s.eyeW));
    this._referenceFaceHeight = median(this._distanceSamples.map((s) => s.faceH));
    this.status.distanceRatio = 1;
    this.status.distanceChanged = false;
    return true;
  }

  clearDistanceReference() {
    this._referenceEyeWidth = null;
    this._referenceFaceHeight = null;
    this.status.distanceRatio = null;
    this.status.distanceChanged = false;
  }

  /** Данни за запазване в профила (последните ~1200 проби, закръглени). */
  exportData() {
    const r = (v) => Math.round(v * 1e5) / 1e5;
    return {
      v: GazeEngine.VERSION, w: innerWidth, h: innerHeight, saved: Date.now(),
      samples: this.samples.slice(-1200).map((s) => [s.f.map(r), Math.round(s.x), Math.round(s.y), s.w, String(s.g)]),
    };
  }

  /** Зарежда запазени проби. Старите сесии тежат по-малко от новите. */
  importData(d) {
    if (!d || d.v !== GazeEngine.VERSION || !Array.isArray(d.samples) || d.samples.length < 40) return false;
    const sx = innerWidth / (d.w || innerWidth), sy = innerHeight / (d.h || innerHeight);
    const session = 'old' + (d.saved || 0) + ':';
    this.samples = d.samples.map(([f, x, y, w, g]) => ({
      f, x: x * sx, y: y * sy, w: Math.max(0.2, (w || 1) * 0.6), g: g.startsWith('old') ? g : session + g,
    }));
    this.fit(true);
    return !!this.model;
  }

  /** Отслабва старите проби, когато дойдат нови от проверката (главата може да е на друго място). */
  ageSamples(factor = 0.6) { for (const s of this.samples) s.w = Math.max(0.15, s.w * factor); }

  fit(crossValidate = true) {
    if (this.samples.length < 20) return null;
    const d = this.samples[0].f.length;
    const mean = new Array(d).fill(0), std = new Array(d).fill(0);
    for (const s of this.samples) s.f.forEach((v, j) => { mean[j] += v; });
    mean.forEach((_, j) => { mean[j] /= this.samples.length; });
    for (const s of this.samples) s.f.forEach((v, j) => { std[j] += (v - mean[j]) ** 2; });
    std.forEach((_, j) => { std[j] = Math.sqrt(std[j] / this.samples.length) || 1; });
    mean[d - 1] = 0; std[d - 1] = 1;                                     // свободният член
    const norm = (f) => f.map((v, j) => (v - mean[j]) / std[j]);
    const X = this.samples.map((s) => norm(s.f));
    const ys = [this.samples.map((s) => s.x), this.samples.map((s) => s.y)];
    const w = this.samples.map((s) => s.w);

    let lambda = this.model ? this.model.lambda : 3;
    if (crossValidate) {
      // избира силата на регуляризацията с „остави една точка навън“
      // проверяваме само върху точките от калибрирането (до 16), за да е бързо
      let groups = [...new Set(this.samples.map((s) => s.g))].filter((g) => !/live/.test(g));
      if (groups.length > 16) groups = groups.filter((_, i) => i % Math.ceil(groups.length / 16) === 0);
      let best = Infinity;
      for (const lam of [0.3, 1, 3, 10, 30, 100]) {
        let err = 0, cnt = 0;
        for (const g of groups) {
          const tr = [], te = [];
          this.samples.forEach((s, i) => (s.g === g ? te : tr).push(i));
          if (tr.length < 20 || !te.length) continue;
          const [wx, wy] = ridge(tr.map((i) => X[i]), [tr.map((i) => ys[0][i]), tr.map((i) => ys[1][i])], tr.map((i) => w[i]), lam);
          for (const i of te) {
            const px = X[i].reduce((a, v, j) => a + v * wx[j], 0), py = X[i].reduce((a, v, j) => a + v * wy[j], 0);
            err += Math.hypot(px - ys[0][i], py - ys[1][i]); cnt++;
          }
        }
        if (cnt && err / cnt < best) { best = err / cnt; lambda = lam; }
      }
    }
    const [wx, wy] = ridge(X, ys, w, lambda);
    this.model = { mean, std, wx, wy, lambda };
    return this.model;
  }

  _predict(f) {
    const { mean, std, wx, wy } = this.model;
    let x = 0, y = 0;
    for (let j = 0; j < f.length; j++) { const v = (f[j] - mean[j]) / std[j]; x += v * wx[j]; y += v * wy[j]; }
    return [x, y];
  }

  /** Предвиждане за набор признаци (за теста на точността). */
  predictMany(feats) {
    if (!this.model || !feats.length) return null;
    const ps = feats.map((f) => this._predict(f));
    return [median(ps.map((p) => p[0])), median(ps.map((p) => p[1]))];
  }

  resetFilter() { this.fx.reset(); this.fy.reset(); this._raw = []; }
}

window.GazeEngine = new GazeEngine();
window.dispatchEvent(new Event('gazeengine-ready'));

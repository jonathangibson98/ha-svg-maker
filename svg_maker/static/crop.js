/* Subject finder for auto-crop. Frequency-tuned saliency (color distance from the
   image average) with a mild center bias. Not face detection: it finds the part of
   the photo that stands out most. */
(function (root) {
  function lin(c) { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  function lab(r, g, b) {
    const R = lin(r), G = lin(g), B = lin(b);
    const X = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
    const Y = R * 0.2126 + G * 0.7152 + B * 0.0722;
    const Z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
    const f = t => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    const fx = f(X), fy = f(Y), fz = f(Z);
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
  }
  function blur3(a, w, h) {
    const t = new Float32Array(a.length), o = new Float32Array(a.length);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const xm = Math.max(0, x - 1), xp = Math.min(w - 1, x + 1);
      t[y * w + x] = (a[y * w + xm] + 2 * a[y * w + x] + a[y * w + xp]) / 4;
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const ym = Math.max(0, y - 1), yp = Math.min(h - 1, y + 1);
      o[y * w + x] = (t[ym * w + x] + 2 * t[y * w + x] + t[yp * w + x]) / 4;
    }
    return o;
  }
  function quantile(arr, q) {
    let tot = 0; for (const v of arr) tot += v;
    if (tot <= 0) return arr.length / 2;
    let acc = 0; const target = tot * q;
    for (let i = 0; i < arr.length; i++) { acc += arr[i]; if (acc >= target) return i + 0.5; }
    return arr.length - 0.5;
  }
  /* data = RGBA bytes of a small thumbnail (w x h). padPct = extra room around subject.
     Returns fractions: fx, fy = center (0..1 of width/height), fsize = square size as a
     fraction of the image's shorter side. */
  function suggest(data, w, h, padPct) {
    const n = w * h;
    let L = new Float32Array(n), A = new Float32Array(n), B = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const c = lab(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
      L[i] = c[0]; A[i] = c[1]; B[i] = c[2];
    }
    L = blur3(blur3(L, w, h), w, h); A = blur3(blur3(A, w, h), w, h); B = blur3(blur3(B, w, h), w, h);
    let mL = 0, mA = 0, mB = 0;
    for (let i = 0; i < n; i++) { mL += L[i]; mA += A[i]; mB += B[i]; }
    mL /= n; mA /= n; mB /= n;
    const sal = new Float32Array(n);
    let mx = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const d = Math.sqrt((L[i] - mL) ** 2 + (A[i] - mA) ** 2 + (B[i] - mB) ** 2);
      const dx = (x + 0.5) / w - 0.5, dy = (y + 0.5) / h - 0.5;
      const prior = 1 - 0.55 * ((dx * dx + dy * dy) / 0.5);
      sal[i] = d * prior;
      if (sal[i] > mx) mx = sal[i];
    }
    const minSide = Math.min(w, h);
    const fallback = { fx: 0.5, fy: 0.5, fsize: 1, found: false };
    if (mx <= 0) return fallback;
    let m = 0; for (let i = 0; i < n; i++) { sal[i] /= mx; m += sal[i]; }
    m /= n;
    let v = 0; for (let i = 0; i < n; i++) v += (sal[i] - m) ** 2;
    const thr = m + 0.6 * Math.sqrt(v / n);
    const col = new Float32Array(w), row = new Float32Array(h);
    let cnt = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const s = sal[y * w + x];
      if (s > thr) { col[x] += s; row[y] += s; cnt++; }
    }
    if (cnt < n * 0.005) return fallback;
    const x1 = quantile(col, 0.04), x2 = quantile(col, 0.96);
    const y1 = quantile(row, 0.04), y2 = quantile(row, 0.96);
    let cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
    let size = Math.max(x2 - x1, y2 - y1) * (1 + 2 * (padPct || 0) / 100);
    // When the subject fills the frame, zoom in a little and aim at the weighted
    // center of the subject instead of the middle of the box.
    if (size > 0.82 * minSide) {
      let sx = 0, sy = 0, sw = 0;
      for (let x = 0; x < w; x++) { sx += (x + 0.5) * col[x]; sw += col[x]; }
      for (let y = 0; y < h; y++) sy += (y + 0.5) * row[y];
      if (sw > 0) { cx = sx / sw; cy = sy / sw; }
      size = 0.82 * minSide;
    }
    size = Math.min(minSide, Math.max(0.45 * minSide, size));
    cx = Math.min(w - size / 2, Math.max(size / 2, cx));
    cy = Math.min(h - size / 2, Math.max(size / 2, cy));
    return { fx: cx / w, fy: cy / h, fsize: size / minSide, found: true };
  }
  const api = { suggest };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CropSuggest = api;
})(typeof window !== 'undefined' ? window : this);

// Bildaufbereitung: alles arbeitet auf { w, h, data } mit data = Uint8Array
// (ein Byte Grauwert pro Pixel). Bewusst ohne Canvas- oder DOM-Bezug, damit
// derselbe Code im Browser und im Node-Testlauf laeuft.

export function gray(w, h, rgba) {
  const out = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = (rgba[p] * 77 + rgba[p + 1] * 150 + rgba[p + 2] * 29) >> 8;
  }
  return { w, h, data: out };
}

/** Summierte Flaechentabelle -- erlaubt Fensterstatistik in konstanter Zeit. */
function integral(img) {
  const { w, h, data } = img;
  const s = new Float64Array((w + 1) * (h + 1));
  const s2 = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let rs = 0, rs2 = 0;
    for (let x = 0; x < w; x++) {
      const v = data[y * w + x];
      rs += v; rs2 += v * v;
      s[(y + 1) * (w + 1) + x + 1] = s[y * (w + 1) + x + 1] + rs;
      s2[(y + 1) * (w + 1) + x + 1] = s2[y * (w + 1) + x + 1] + rs2;
    }
  }
  return { s, s2, w: w + 1 };
}

function boxSum(t, x0, y0, x1, y1) {
  const { s, w } = t;
  return s[y1 * w + x1] - s[y0 * w + x1] - s[y1 * w + x0] + s[y0 * w + x0];
}
function boxSum2(t, x0, y0, x1, y1) {
  const { s2, w } = t;
  return s2[y1 * w + x1] - s2[y0 * w + x1] - s2[y1 * w + x0] + s2[y0 * w + x0];
}

/**
 * Sauvola-Schwellwert: lokal statt global. Genau das, was Handyfotos
 * brauchen -- ein Schatten ueber der Seite oder ein heller Fleck kippt
 * eine globale Schwelle sofort, eine lokale nicht.
 *
 * Ergebnis: Uint8Array mit 1 = Tinte, 0 = Papier.
 */
export function binarize(img, { window: win = 0, k = 0.25, R = 128 } = {}) {
  const { w, h, data } = img;
  const r = Math.max(4, Math.round((win || Math.max(w, h) / 24) / 2));
  const t = integral(img);
  const ink = new Uint8Array(w * h);
  let dark = 0;

  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      const n = (x1 - x0) * (y1 - y0);
      const mean = boxSum(t, x0, y0, x1, y1) / n;
      const varc = Math.max(0, boxSum2(t, x0, y0, x1, y1) / n - mean * mean);
      const thr = mean * (1 + k * (Math.sqrt(varc) / R - 1));
      if (data[y * w + x] < thr) { ink[y * w + x] = 1; dark++; }
    }
  }
  return { w, h, ink, coverage: dark / (w * h) };
}

/**
 * Invertiert falls noetig. Briefe sind dunkle Schrift auf hellem Papier;
 * kippt die Aufnahme (Blitz, Negativ, dunkles Papier), wuerde sonst das
 * Papier als Tinte gelten. Ueber 35 % Deckung ist praktisch immer verdreht.
 */
export function normalizePolarity(bin) {
  if (bin.coverage <= 0.35) return bin;
  const ink = new Uint8Array(bin.ink.length);
  for (let i = 0; i < ink.length; i++) ink[i] = bin.ink[i] ? 0 : 1;
  return { ...bin, ink, coverage: 1 - bin.coverage, inverted: true };
}

/**
 * Entfernt isolierte Tintenpixel (weniger als `minNeighbors` Nachbarn im
 * 3x3-Fenster). Handyfotos von Bildschirmen (Moiré) oder verrauschte Fotos
 * streuen einzelne Pixel in die Luecken zwischen Zeilen -- genug, um
 * findLines dazu zu bringen, mehrere Textzeilen als eine zu verschmelzen.
 * Echte Glyphenstriche haben immer mehrere zusammenhaengende Nachbarn und
 * bleiben unangetastet.
 */
export function despeckle(bin, minNeighbors = 2) {
  const { w, h, ink } = bin;
  const out = new Uint8Array(ink);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - 1), y1 = Math.min(h - 1, y + 1);
    for (let x = 0; x < w; x++) {
      if (!ink[y * w + x]) continue;
      const x0 = Math.max(0, x - 1), x1 = Math.min(w - 1, x + 1);
      let n = -1; // sich selbst nicht mitzaehlen
      for (let yy = y0; yy <= y1; yy++) {
        for (let xx = x0; xx <= x1; xx++) n += ink[yy * w + xx];
      }
      if (n < minNeighbors) out[y * w + x] = 0;
    }
  }
  return { ...bin, ink: out };
}

/** Zeilenprofil: Tintenmenge je Bildzeile, nach Drehung um `angle`. */
function rowProfile(bin, angle) {
  const { w, h, ink } = bin;
  const prof = new Float64Array(h);
  const tan = Math.tan(angle);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!ink[y * w + x]) continue;
      const yy = y + Math.round((x - w / 2) * tan);
      if (yy >= 0 && yy < h) prof[yy]++;
    }
  }
  return prof;
}

/**
 * Schaetzt die Schieflage. Bei der richtigen Drehung fallen die Zeilen
 * zusammen -- das Zeilenprofil wird maximal zackig. Also: den Winkel
 * suchen, der die Varianz des Profils maximiert.
 */
function skewScore(bin, deg) {
  const prof = rowProfile(bin, (deg * Math.PI) / 180);
  let mean = 0;
  for (const v of prof) mean += v;
  mean /= prof.length;
  let varc = 0;
  for (const v of prof) varc += (v - mean) * (v - mean);
  return varc;
}

/**
 * Schaetzt die Schieflage in zwei Stufen: erst grob, dann fein um das
 * Ergebnis herum. Eine Restschraeglage von 0,25 Grad klingt harmlos, laesst
 * die Grundlinie auf einer 1000 Pixel breiten Zeile aber um vier Pixel
 * wandern -- genug, um die Erkennung zum Zeilenende hin zu verderben.
 */
export function estimateSkew(bin, maxDeg = 12, coarse = 25, fine = 17) {
  let best = 0, bestScore = -Infinity;
  for (let i = 0; i < coarse; i++) {
    const deg = -maxDeg + (2 * maxDeg * i) / (coarse - 1);
    const s = skewScore(bin, deg);
    if (s > bestScore) { bestScore = s; best = deg; }
  }
  const step = (2 * maxDeg) / (coarse - 1);
  const centre = best;               // festhalten: best wandert sonst mit
  for (let i = 0; i < fine; i++) {
    const deg = centre - step + (2 * step * i) / (fine - 1);
    const s = skewScore(bin, deg);
    if (s > bestScore) { bestScore = s; best = deg; }
  }
  return best;
}

/** Dreht das Binaerbild um `deg` (Nearest Neighbour reicht fuer Masken). */
export function rotate(bin, deg) {
  if (Math.abs(deg) < 0.1) return bin;
  const { w, h, ink } = bin;
  const a = (-deg * Math.PI) / 180;
  const cos = Math.cos(a), sin = Math.sin(a);
  const cx = w / 2, cy = h / 2;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - cx, dy = y - cy;
      const sx = Math.round(cx + dx * cos + dy * sin);
      const sy = Math.round(cy - dx * sin + dy * cos);
      if (sx >= 0 && sx < w && sy >= 0 && sy < h) out[y * w + x] = ink[sy * w + sx];
    }
  }
  return { ...bin, ink: out };
}

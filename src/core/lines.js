// Findet Textzeilen und schaetzt je Zeile Grundlinie und Schriftgroesse.

/** Vertikale Ausdehnung einer Schrift in em, ueber alle 26 Runen vereint. */
export function fontExtent(font, emPx) {
  let top = Infinity, bottom = -Infinity;
  const heights = [];
  for (const g of Object.values(font.letters)) {
    if (!g.h) continue;
    top = Math.min(top, g.y0);
    bottom = Math.max(bottom, g.y0 + g.h / emPx);
    heights.push(g.h / emPx);
  }
  heights.sort((a, b) => a - b);
  const medianH = heights[Math.floor(heights.length / 2)] || 1;
  return { top, bottom, height: bottom - top, medianH };
}

/**
 * Zerlegt das Binaerbild in Zeilen.
 *
 * Saubere Scans: Tinte-Baender mit fast leeren Taelern (klassischer Schwellwert).
 * Handyfotos: zwischen den Zeilen bleibt oft 20–40 % Rest-Tinte (Schatten,
 * JPEG, Papierstruktur) — dann greift die Tal-Suche ueber das geglaettete
 * Profil, sonst verschmelzen alle Zeilen zu einer Mega-Zeile.
 */
export function findLines(bin, opts = {}) {
  const { minInk = 0.02, minHeight = 8, splitConnected = true } = opts;
  const prof = rowProfile(bin);
  let peak = 0;
  for (const v of prof) peak = Math.max(peak, v);
  if (!peak) return [];

  const classicBands = bandsAbove(prof, Math.max(1, peak * minInk), minHeight);
  const classic = boundLines(bin, classicBands);
  const maxH = classicBands.reduce((m, l) => Math.max(m, l.y1 - l.y0), 0);
  const pitch = estimateLinePitch(prof);
  // Bei großen Phoenix-Runen sind hohe klassische Bänder echte Zeilen.
  // Tal-/Periodensuche würde ihre ornamentierten Querstriche zerschneiden.
  if (!splitConnected && classic.length) return classic;
  // Eine Zeile, die mehr als ~18 % der Seite einnimmt, ist auf einem Brief
  // unrealistisch — typisches Zeichen, dass der Schwellwert die Luecken nicht sieht.
  if (classic.length >= 1 && maxH <= bin.h * 0.18) {
    const maySplitClassic = splitConnected
      ? classic.length >= 3 && classic.length <= 12
      : classic.length === 1;
    if (maySplitClassic
        && pitch >= 7 && maxH > pitch * 1.55) {
      return boundLines(bin, splitTallBands(classicBands, pitch));
    }
    return classic;
  }

  return findLinesByValleys(bin, prof, peak, opts);
}

function rowProfile(bin) {
  const { w, h, ink } = bin;
  const prof = new Float64Array(h);
  for (let y = 0; y < h; y++) {
    let n = 0;
    for (let x = 0; x < w; x++) n += ink[y * w + x];
    prof[y] = n;
  }
  return prof;
}

function bandsAbove(prof, thr, minHeight) {
  const lines = [];
  let start = -1;
  for (let y = 0; y <= prof.length; y++) {
    const on = y < prof.length && prof[y] >= thr;
    if (on && start < 0) start = y;
    if (!on && start >= 0) {
      if (y - start >= minHeight) lines.push({ y0: start, y1: y });
      start = -1;
    }
  }
  return lines;
}

/**
 * Handyfoto-Pfad: lokale Minima im geglaetteten Profil als Zeilentrenner.
 * Anschliessend kurze Fragmente zusammenkleben.
 */
function findLinesByValleys(bin, prof, peak, opts = {}) {
  const {
    minHeight = 8,
    smooth = 3,
    maxRel = 0.8,
    minPeakFrac = 0.18,
  } = opts;
  const h = prof.length;
  const sm = new Float64Array(h);
  for (let y = 0; y < h; y++) {
    let s = 0, c = 0;
    for (let yy = Math.max(0, y - smooth); yy <= Math.min(h - 1, y + smooth); yy++) {
      s += prof[yy];
      c++;
    }
    sm[y] = s / c;
  }

  const splits = [-1];
  for (let y = smooth; y < h - smooth; y++) {
    if (!(sm[y] <= sm[y - 1] && sm[y] <= sm[y + 1])) continue;
    let left = 0, right = 0;
    for (let yy = Math.max(0, y - 40); yy < y; yy++) left = Math.max(left, sm[yy]);
    for (let yy = y + 1; yy <= Math.min(h - 1, y + 40); yy++) right = Math.max(right, sm[yy]);
    const neigh = Math.min(left, right);
    if (neigh < peak * minPeakFrac) continue;
    if (sm[y] / neigh <= maxRel && sm[y] / peak < 0.55) splits.push(y);
  }
  splits.push(h);

  const uniq = [];
  for (const s of splits) {
    if (!uniq.length || s - uniq[uniq.length - 1] > 2) uniq.push(s);
  }

  let lines = [];
  for (let i = 0; i < uniq.length - 1; i++) {
    const y0 = uniq[i] + 1, y1 = uniq[i + 1];
    if (y1 - y0 < minHeight) continue;
    let inkSum = 0;
    for (let y = y0; y < y1; y++) inkSum += prof[y];
    if (inkSum < peak * 0.5) continue;
    lines.push({ y0, y1 });
  }

  lines = mergeThinBands(lines);

  if (lines.length >= 3) {
    const hs = lines.map((l) => l.y1 - l.y0).sort((a, b) => a - b);
    const med = hs[hs.length >> 1] || 20;
    lines = lines.filter((l) => l.y1 - l.y0 <= med * 2.4);
  }

  // Bei hohen/verbundenen Schriften (Taluz) beruehren sich benachbarte
  // Textzeilen. Die Tal-Suche findet dann nur ganze Absaetze. Der periodische
  // Zeilenabstand bleibt aber in der Ableitung des Profils sichtbar.
  const pitch = estimateLinePitch(prof);
  const maySplitValleys = opts.splitConnected !== false
    ? lines.length >= 3 && lines.length <= 12
    : lines.length === 1;
  if (maySplitValleys && pitch >= 7) {
    lines = splitTallBands(lines, pitch);
  }

  return boundLines(bin, lines);
}

/** Klebt uebersplittene Kurzbaender (Luecke <= 3 px) zu einer Zeile. */
function mergeThinBands(lines) {
  if (lines.length < 2) return lines;
  const heights = lines.map((l) => l.y1 - l.y0).sort((a, b) => a - b);
  const target = heights[heights.length >> 1] || 20;
  const out = [{ ...lines[0] }];
  for (let i = 1; i < lines.length; i++) {
    const prev = out[out.length - 1];
    const cur = lines[i];
    const gap = cur.y0 - prev.y1;
    const mergedH = cur.y1 - prev.y0;
    if (gap <= 3 && mergedH <= target * 1.65) {
      prev.y1 = cur.y1;
    } else {
      out.push({ ...cur });
    }
  }
  return out;
}

/** Staerkster periodischer Abstand im Hochpass-Zeilenprofil. */
function estimateLinePitch(prof) {
  if (prof.length < 30) return 0;
  const diff = new Float64Array(prof.length);
  for (let y = 1; y < prof.length; y++) diff[y] = prof[y] - prof[y - 1];
  // Unter 9 px entstehen bei 1100px-Briefen eher Glyphen-Innenmuster als
  // echte Druckzeilen; diese Peaks fuehren sonst zu massiver Ueberteilung.
  const lo = 9, hi = Math.min(80, Math.floor(prof.length / 3));
  const scores = new Float64Array(hi + 1);
  for (let lag = lo; lag <= hi; lag++) {
    let s = 0, n = 0;
    for (let y = 1; y + lag < diff.length; y++) {
      s += diff[y] * diff[y + lag];
      n++;
    }
    scores[lag] = s / Math.max(n, 1);
  }
  let best = 0, bestScore = 0;
  for (let lag = lo + 1; lag < hi; lag++) {
    if (scores[lag] >= scores[lag - 1]
        && scores[lag] >= scores[lag + 1]
        && scores[lag] > bestScore) {
      best = lag;
      bestScore = scores[lag];
    }
  }
  // Autokorrelation zeigt auch Vielfache des echten Zeilenabstands. Wenn
  // deren Peak minimal hoeher ist, wuerden sonst ganze Absaetze nur halbiert.
  // Daher den kleinsten starken Peak als Grundperiode nehmen.
  if (bestScore > 0) {
    for (let lag = lo + 1; lag < best; lag++) {
      if (scores[lag] >= scores[lag - 1]
          && scores[lag] >= scores[lag + 1]
          && scores[lag] >= bestScore * 0.5) {
        return lag;
      }
    }
  }
  return best;
}

/** Teilt Absatz-Baender gleichmaessig anhand des geschaetzten Zeilenabstands. */
function splitTallBands(lines, pitch) {
  const out = [];
  for (const line of lines) {
    const height = line.y1 - line.y0;
    if (height <= pitch * 1.55) {
      out.push(line);
      continue;
    }
    const count = Math.max(2, Math.round((height + pitch * 0.15) / pitch));
    const step = height / count;
    for (let i = 0; i < count; i++) {
      out.push({
        y0: Math.floor(line.y0 + i * step),
        y1: Math.ceil(line.y0 + (i + 1) * step),
      });
    }
  }
  return out;
}

/** Beschneidet eine Zeile links/rechts auf den tatsaechlichen Tintenbereich. */
function withBounds(bin, line) {
  const { w, ink } = bin;
  let x0 = w, x1 = 0;
  for (let y = line.y0; y < line.y1; y++) {
    for (let x = 0; x < w; x++) {
      if (ink[y * w + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; }
    }
  }
  return { ...line, x0, x1: x1 + 1 };
}

function boundLines(bin, lines) {
  return lines
    .map((line) => withBounds(bin, line))
    .filter((line) => line.x1 > line.x0 && line.y1 > line.y0);
}

/**
 * Schneidet eine Zeile als eigenstaendiges Bild heraus, mit etwas Luft, damit
 * Runen die ueber die Zeilengrenze ragen nicht abgeschnitten werden.
 */
export function cropLine(bin, line, pad = 4) {
  const y0 = Math.max(0, line.y0 - pad), y1 = Math.min(bin.h, line.y1 + pad);
  const x0 = Math.max(0, line.x0 - pad), x1 = Math.min(bin.w, line.x1 + pad);
  const w = x1 - x0, h = y1 - y0;
  const ink = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) ink[y * w + x] = bin.ink[(y + y0) * bin.w + x + x0];
  }
  return { w, h, ink, offsetX: x0, offsetY: y0, inkTop: line.y0 - y0, inkBottom: line.y1 - y0 };
}

/**
 * Schaetzt Schriftgroesse und Grundlinie aus der Zeilenhoehe.
 *
 * Die Tintenhoehe entspricht der vollen Schriftausdehnung nur, wenn die Zeile
 * auch Runen mit extremer Ober- und Unterlaenge enthaelt. Sonst (Nalya u. a.)
 * waere em = inkHeight / extent.height deutlich zu klein. Deshalb die Spanne
 * zwischen voller Ausdehnung und typischer (medianer) Buchstabenhoehe.
 *
 * Die Grundlinie haengt davon ab, ob die Zeile die hoechste oder tiefste Rune
 * der Schrift enthaelt -- beides wird als Kandidat mitgefuehrt, der Decoder
 * nimmt die besser passende.
 */
export function scaleCandidates(lineImg, extent, opts = {}) {
  const spread = opts.spread ?? 0.25;
  const around = opts.around ?? 0;
  const aroundBaseline = opts.aroundBaseline;
  const inkHeight = Math.max(1, lineImg.inkBottom - lineImg.inkTop);

  let lo, hi, steps;
  if (around) {
    steps = opts.steps ?? 9;
    lo = around * (1 - spread);
    hi = around * (1 + spread);
  } else {
    const emFull = inkHeight / Math.max(extent.height, 1e-6);
    const emMed = inkHeight / Math.max(extent.medianH || extent.height, 1e-6);
    lo = Math.min(emFull, emMed) * 0.9;
    hi = Math.max(emFull, emMed) * (1 + spread);
    if (opts.steps) {
      steps = opts.steps;
    } else {
      const rel = (hi - lo) / Math.max(lo, 1);
      steps = Math.max(7, Math.min(9, Math.round(rel / 0.08) + 1));
    }
  }

  const out = [];
  const push = (e, baseline) => {
    if (e >= 6) out.push({ em: e, baseline });
  };
  for (let i = 0; i < steps; i++) {
    const e = steps === 1 ? (lo + hi) / 2 : lo + ((hi - lo) * i) / (steps - 1);
    if (aroundBaseline != null) {
      push(e, aroundBaseline);
      continue;
    }
    const bBot = lineImg.inkBottom - extent.bottom * e;
    const bTop = lineImg.inkTop - extent.top * e;
    push(e, bBot);
    if (Math.abs(bTop - bBot) > 3) {
      push(e, bTop);
      push(e, (bTop + bBot) / 2);
    }
  }
  return out;
}

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
 * Zerlegt das Binaerbild in Zeilen. Ueber das Zeilenprofil: zusammenhaengende
 * Baender mit Tinte sind Zeilen, die Taeler dazwischen die Zeilenabstaende.
 */
export function findLines(bin, { minInk = 0.02, minHeight = 8 } = {}) {
  const { w, h, ink } = bin;
  const prof = new Int32Array(h);
  for (let y = 0; y < h; y++) {
    let n = 0;
    for (let x = 0; x < w; x++) n += ink[y * w + x];
    prof[y] = n;
  }
  let peak = 0;
  for (const v of prof) peak = Math.max(peak, v);
  if (!peak) return [];

  const thr = Math.max(1, peak * minInk);
  const lines = [];
  let start = -1;
  for (let y = 0; y <= h; y++) {
    const on = y < h && prof[y] >= thr;
    if (on && start < 0) start = y;
    if (!on && start >= 0) {
      if (y - start >= minHeight) lines.push({ y0: start, y1: y });
      start = -1;
    }
  }
  return lines.map((l) => withBounds(bin, l));
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

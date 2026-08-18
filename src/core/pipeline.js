// Setzt die Einzelschritte zu einer Uebersetzung zusammen.

import { binarize, despeckle, estimateSkew, normalizePolarity, rotate } from "./image.js";
import { cropLine, findLines, fontExtent, scaleCandidates } from "./lines.js";
import { decodeLine, scaleGlyphs } from "./decode.js";
import { ambiguityMap } from "./atlas.js";

/**
 * Erkennt eine Seite in einer bekannten Sprache.
 * `img` ist ein Graustufenbild { w, h, data }.
 */
export function readPage(img, atlas, fontName, opts = {}) {
  let bin = normalizePolarity(binarize(img, opts.binarize));
  const despecklePasses = opts.despeckle ?? 0;
  for (let i = 0; i < despecklePasses; i++) bin = despeckle(bin);
  const skew = opts.deskew === false ? 0 : estimateSkew(bin);
  const straight = rotate(bin, skew);

  const font = atlas.fonts[fontName];
  const extent = fontExtent(font, atlas.emPx);
  const amb = ambiguityMap(font);
  let advSum = 0, advN = 0;
  for (const g of Object.values(font.letters)) {
    if (g.adv) { advSum += g.adv; advN++; }
  }
  const avgAdvEm = advSum / Math.max(advN, 1);
  const glyphCache = new Map();
  const glyphsAt = (em) => {
    const key = em.toFixed(2);
    let g = glyphCache.get(key);
    if (!g) {
      g = scaleGlyphs(font, atlas.emPx, em, atlas.alphabet);
      glyphCache.set(key, g);
    }
    return g;
  };

  const lines = [];
  for (const line of findLines(straight)) {
    const img2 = cropLine(straight, line);

    const tryCand = (cand) => {
      const glyphs = glyphsAt(cand.em);
      const res = decodeLine({ ...img2, baseline: cand.baseline }, glyphs,
                             atlas.alphabet, opts.decode);
      const expected = img2.w / Math.max(cand.em * avgAdvEm, 1);
      const extra = Math.max(0, (res.glyphCount || 0) - expected * 1.3);
      return { ...res, ...cand, adj: res.score - 0.02 * extra };
    };

    // Zweistufig: die Schriftgroesse muss auf etwa ein Prozent genau
    // stimmen. Bei groeberer Suche summiert sich der Fehler ueber zwanzig
    // Runen zu mehr als einer ganzen Runenbreite auf, und die Zeile
    // "verrutscht" nach hinten raus.
    let best = null;
    const coarse = scaleCandidates(img2, extent, opts.scale);
    for (const cand of coarse) {
      const r = tryCand(cand);
      if (!best || r.adj > best.adj) best = r;
    }
    if (best) {
      const ems = [...new Set(coarse.map((c) => c.em))].sort((a, b) => a - b);
      const coarseStep = ems.length >= 2 ? ems[1] - ems[0] : best.em * 0.08;
      const fineSpread = (coarseStep / best.em) * 1.1;
      for (const cand of scaleCandidates(img2, extent, {
        spread: fineSpread,
        steps: opts.scale?.fineSteps ?? 9,
        around: best.em,
        aroundBaseline: best.baseline,
      })) {
        const r = tryCand(cand);
        if (r.adj > best.adj) best = r;
      }
    }

    if (best && best.text) {
      lines.push({ ...best, box: { x0: line.x0, y0: line.y0, x1: line.x1, y1: line.y1 } });
    }
  }

  const text = lines.map((l) => l.text).join("\n");
  const confidence = lines.length
    ? lines.reduce((s, l) => s + l.score, 0) / lines.length
    : 0;
  return { text, lines, confidence, skew, ambiguous: amb, inverted: !!bin.inverted };
}

/**
 * Erkennt eine Seite, ohne die Sprache zu kennen: probiert alle durch und
 * nimmt die mit der besten Bewertung.
 */
export function readPageAutoFont(img, atlas, opts = {}) {
  let best = null;
  for (const name of Object.keys(atlas.fonts)) {
    const res = readPage(img, atlas, name, opts);
    if (!best || res.confidence > best.confidence) best = { ...res, font: name };
  }
  return best;
}

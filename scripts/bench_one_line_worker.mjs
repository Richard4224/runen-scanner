// Dekodiert eine Teilmenge der Zeilen eines Fotos (Worker fuer bench_one_parallel.mjs).

import fs from "node:fs";
import { parentPort, workerData } from "node:worker_threads";

import { prepareAtlas } from "../src/core/atlas.js";
import { scaleCandidates } from "../src/core/lines.js";
import { decodeLine, scaleGlyphs } from "../src/core/decode.js";

const { atlasPath, font: fontName, avgAdvEm, extent, alphabet, emPx, lines } = workerData;
const atlas = prepareAtlas(JSON.parse(fs.readFileSync(atlasPath, "utf8")));
const font = atlas.fonts[fontName];
const glyphCache = new Map();
const glyphsAt = (em) => {
  const key = em.toFixed(2);
  let g = glyphCache.get(key);
  if (!g) {
    g = scaleGlyphs(font, emPx, em, alphabet);
    glyphCache.set(key, g);
  }
  return g;
};

const out = [];
for (const job of lines) {
  const img2 = {
    w: job.w,
    h: job.h,
    ink: new Uint8Array(job.ink),
    inkTop: job.inkTop,
    inkBottom: job.inkBottom,
  };

  const tryCand = (cand) => {
    const glyphs = glyphsAt(cand.em);
    const res = decodeLine({ ...img2, baseline: cand.baseline }, glyphs, alphabet, { em: cand.em });
    const expected = img2.w / Math.max(cand.em * avgAdvEm, 1);
    const extra = Math.max(0, (res.glyphCount || 0) - expected * 1.3);
    return { ...res, ...cand, adj: res.score - 0.02 * extra };
  };

  let best = null;
  const coarse = scaleCandidates(img2, extent);
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
      steps: 9,
      around: best.em,
      aroundBaseline: best.baseline,
    })) {
      const r = tryCand(cand);
      if (r.adj > best.adj) best = r;
    }
  }

  out.push({
    i: job.i,
    text: best?.text || "",
    score: best?.score || 0,
    em: best?.em || 0,
  });
}
parentPort.postMessage(out);

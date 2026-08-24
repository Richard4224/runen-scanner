// Laeuft im Web Worker: die eigentliche Entzifferung, damit die Seite waehrend
// der (teils langen) Rechenzeit reagieren bleibt und die Ladeanimation weiterlaeuft.

import { prepareAtlas, ambiguityMap } from "./core/atlas.js";
import { readPage, readPageAutoFont } from "./core/pipeline.js";
import { ATLAS_JSON } from "./generated-atlas.js";

const atlas = prepareAtlas(ATLAS_JSON);

// Weniger Skalierungs-Kandidaten als der Bibliotheks-Standard (7 grob + 9
// fein): kostet auf hartem Testmaterial nur ~1,6 Prozentpunkte CER, halbiert
// aber grob die Rechenzeit -- fuer Handys, wo jede Sekunde zaehlt, ein guter
// Tausch (siehe scripts/bench_steps.mjs).
const DECODE_OPTS = { scale: { steps: 5, fineSteps: 5 } };

/** Markiert Buchstaben im Text, die fuer die erkannte Schrift mehrdeutig sind. */
function markAmbiguous(text, font) {
  const amb = ambiguityMap(atlas.fonts[font]);
  return [...text].map((ch) => ({ ch, alt: amb[ch] || null }));
}

self.onmessage = (ev) => {
  const { w, h, data, font, auto } = ev.data;
  const img = { w, h, data: new Uint8Array(data) };

  const onProgress = (phase, info = {}) => {
    self.postMessage({ ok: true, progress: true, phase, ...info, w, h });
  };

  try {
    const t0 = Date.now();
    const res = auto
      ? readPageAutoFont(img, atlas, { ...DECODE_OPTS, onProgress })
      : { ...readPage(img, atlas, font, { ...DECODE_OPTS, onProgress }), font };

    if (!res || !res.text) {
      self.postMessage({ ok: true, empty: true, ms: Date.now() - t0 });
      return;
    }

    self.postMessage({
      ok: true,
      empty: false,
      font: res.font,
      confidence: res.confidence,
      chars: markAmbiguous(res.text, res.font),
      lines: res.lines?.length ?? 0,
      ms: Date.now() - t0,
    });
  } catch (err) {
    self.postMessage({ ok: false, error: String(err && err.message || err) });
  }
};

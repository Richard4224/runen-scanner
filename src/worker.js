// Laeuft im Web Worker: die eigentliche Entzifferung, damit die Seite waehrend
// der (teils langen) Rechenzeit reagieren bleibt und die Ladeanimation weiterlaeuft.

import { prepareAtlas, ambiguityMap } from "./core/atlas.js";
import { readPageCrnn } from "./core/crnn.js";
import { readPage, readPageAutoFont } from "./core/pipeline.js";
import { ATLAS_JSON } from "./generated-atlas.js";
import { ORT_WASM_BASE64, TALUZ_MODEL_BASE64 } from "./generated-crnn.js";
import * as ort from "onnxruntime-web/wasm";

const atlas = prepareAtlas(ATLAS_JSON);

// Weniger Skalierungs-Kandidaten als der Bibliotheks-Standard (7 grob + 9
// fein): kostet auf hartem Testmaterial nur ~1,6 Prozentpunkte CER, halbiert
// aber grob die Rechenzeit -- fuer Handys, wo jede Sekunde zaehlt, ein guter
// Tausch (siehe scripts/bench_steps.mjs).
const DECODE_OPTS = { scale: { steps: 5, fineSteps: 5 } };
let crnnSessionPromise = null;

function decodeBase64(value) {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function getCrnnSession() {
  if (!crnnSessionPromise) {
    ort.env.wasm.numThreads = 1; // iOS braucht kein SharedArrayBuffer
    ort.env.wasm.simd = true;
    ort.env.wasm.proxy = false;
    ort.env.wasm.wasmBinary = decodeBase64(ORT_WASM_BASE64);
    const model = decodeBase64(TALUZ_MODEL_BASE64);
    crnnSessionPromise = ort.InferenceSession.create(model, {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
    });
  }
  return crnnSessionPromise;
}

/** Markiert Buchstaben im Text, die fuer die erkannte Schrift mehrdeutig sind. */
function markAmbiguous(text, font) {
  const amb = ambiguityMap(atlas.fonts[font]);
  return [...text].map((ch) => ({ ch, alt: amb[ch] || null }));
}

self.onmessage = async (ev) => {
  const { w, h, data, font, auto, engine = "classic" } = ev.data;
  const img = { w, h, data: new Uint8Array(data) };

  const onProgress = (phase, info = {}) => {
    self.postMessage({ ok: true, progress: true, phase, ...info, w, h });
  };

  try {
    const t0 = Date.now();
    let res;
    if (engine === "crnn") {
      if (auto || font !== "Phoenix-Taluz") {
        throw new Error("Das schnelle Modell ist derzeit nur für Taluz verfügbar.");
      }
      onProgress("model");
      const session = await getCrnnSession();
      res = { ...await readPageCrnn(img, ort, session, { onProgress }), font };
    } else {
      res = auto
        ? readPageAutoFont(img, atlas, { ...DECODE_OPTS, onProgress })
        : { ...readPage(img, atlas, font, { ...DECODE_OPTS, onProgress }), font };
    }

    if (!res || !res.text) {
      self.postMessage({ ok: true, empty: true, ms: Date.now() - t0, engine });
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
      engine,
    });
  } catch (err) {
    self.postMessage({ ok: false, error: String(err && err.message || err) });
  }
};

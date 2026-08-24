// Laeuft im Web Worker: die eigentliche Entzifferung, damit die Seite waehrend
// der (teils langen) Rechenzeit reagieren bleibt und die Ladeanimation weiterlaeuft.

import { prepareAtlas, ambiguityMap } from "./core/atlas.js";
import { readPageCrnn } from "./core/crnn.js";
import { readPage, readPageAutoFont } from "./core/pipeline.js";
import { ATLAS_JSON } from "./generated-atlas.js";
import { CRNN_MODEL_FILES, CRNN_MODELS_BASE64, ORT_WASM_BASE64 } from "./generated-crnn.js";
import * as ort from "onnxruntime-web/wasm";

const atlas = prepareAtlas(ATLAS_JSON);

// Weniger Skalierungs-Kandidaten als der Bibliotheks-Standard (7 grob + 9
// fein): kostet auf hartem Testmaterial nur ~1,6 Prozentpunkte CER, halbiert
// aber grob die Rechenzeit -- fuer Handys, wo jede Sekunde zaehlt, ein guter
// Tausch (siehe scripts/bench_steps.mjs).
const DECODE_OPTS = { scale: { steps: 5, fineSteps: 5 } };
const crnnSessions = new Map();
let ortConfigured = false;

function decodeBase64(value) {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function getCrnnSession(font, assetBase) {
  let promise = crnnSessions.get(font);
  if (!promise) {
    if (!CRNN_MODEL_FILES[font]) {
      throw new Error(`Kein Schnellmodell für ${font} eingebettet.`);
    }
    if (!ortConfigured) {
      const cores = self.navigator?.hardwareConcurrency || 2;
      ort.env.wasm.simd = true;
      ort.env.wasm.proxy = false;
      if (assetBase && (self.crossOriginIsolated || !ORT_WASM_BASE64)) {
        ort.env.wasm.numThreads = self.crossOriginIsolated
          ? Math.min(4, Math.max(2, cores))
          : 1;
        ort.env.wasm.wasmPaths = {
          wasm: new URL("ort-wasm-simd-threaded.wasm", assetBase).href,
          mjs: new URL("ort-wasm-simd-threaded.mjs", assetBase).href,
        };
      } else {
        ort.env.wasm.numThreads = 1;
        ort.env.wasm.wasmBinary = decodeBase64(ORT_WASM_BASE64);
      }
      ortConfigured = true;
    }
    const embedded = CRNN_MODELS_BASE64[font];
    const modelPromise = embedded
      ? Promise.resolve(decodeBase64(embedded))
      : fetch(new URL(CRNN_MODEL_FILES[font], assetBase))
        .then((response) => {
          if (!response.ok) throw new Error(`Modell konnte nicht geladen werden (${response.status}).`);
          return response.arrayBuffer();
        })
        .then((buffer) => new Uint8Array(buffer));
    promise = modelPromise.then((model) => ort.InferenceSession.create(model, {
        executionProviders: ["wasm"],
        graphOptimizationLevel: "all",
      }));
    crnnSessions.set(font, promise);
  }
  return promise;
}

/** Markiert Buchstaben im Text, die fuer die erkannte Schrift mehrdeutig sind. */
function markAmbiguous(text, font) {
  const amb = ambiguityMap(atlas.fonts[font]);
  return [...text].map((ch) => ({ ch, alt: amb[ch] || null }));
}

self.onmessage = async (ev) => {
  const { w, h, data, font, auto, engine = "classic", assetBase } = ev.data;
  const img = { w, h, data: new Uint8Array(data) };

  const onProgress = (phase, info = {}) => {
    self.postMessage({ ok: true, progress: true, phase, ...info, w, h });
  };

  try {
    const t0 = Date.now();
    let res;
    if (engine === "crnn") {
      if (auto) {
        throw new Error("Automatische Schrifterkennung ist im Schnellmodus noch nicht verfügbar.");
      }
      onProgress("model");
      const session = await getCrnnSession(font, assetBase);
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

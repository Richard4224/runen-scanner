// Zeitmessung: echte Handyfotos durch die JS-Pipeline, mit Downscale.
// Testet nur die Rechenzeit/Grobfunktion -- kein Ersatz fuer einen echten
// Browsertest, aber core/*.js ist bewusst DOM-frei und laeuft identisch hier.

import fs from "node:fs";
import { prepareAtlas } from "../src/core/atlas.js";
import { readPageAutoFont, readPage } from "../src/core/pipeline.js";
import { decodeJpegOriented } from "./image_io.mjs";

const maxDim = Number(process.argv[3] || 1600);
const file = process.argv[2] || "img/ABC test bild gerade.jpg";

const atlas = prepareAtlas(JSON.parse(fs.readFileSync("src/atlas.json", "utf8")));

const raw = await decodeJpegOriented(file);
console.log(`Quelle: ${raw.width}x${raw.height}`);

function downscale(rgba, w, h, maxDim) {
  const scale = Math.min(1, maxDim / Math.max(w, h));
  if (scale >= 1) return { data: rgba, w, h };
  const dw = Math.round(w * scale), dh = Math.round(h * scale);
  const out = new Uint8Array(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(h - 1, Math.floor((y + 0.5) / scale));
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(w - 1, Math.floor((x + 0.5) / scale));
      const si = (sy * w + sx) * 4, di = (y * dw + x) * 4;
      out[di] = rgba[si]; out[di + 1] = rgba[si + 1];
      out[di + 2] = rgba[si + 2]; out[di + 3] = rgba[si + 3];
    }
  }
  return { data: out, w: dw, h: dh };
}

function gray(w, h, rgba) {
  const out = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = (rgba[p] * 77 + rgba[p + 1] * 150 + rgba[p + 2] * 29) >> 8;
  }
  return { w, h, data: out };
}

const small = downscale(raw.data, raw.width, raw.height, maxDim);
console.log(`Downscale (max ${maxDim}px): ${small.w}x${small.h}`);
const img = gray(small.w, small.h, small.data);

const t0 = Date.now();
const res = readPageAutoFont(img, atlas, {});
const t1 = Date.now();

console.log(`Zeit: ${((t1 - t0) / 1000).toFixed(1)}s   Font: ${res?.font}   Konfidenz: ${res?.confidence?.toFixed(2)}`);
console.log(`Zeilen: ${res?.lines?.length}`);
console.log("---");
console.log(res?.text || "(nichts erkannt)");

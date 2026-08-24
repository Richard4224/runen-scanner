// Worker fuer bench_real_set.mjs: JPEG laden, Header croppen, dekodieren.

import fs from "node:fs";
import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";

import { prepareAtlas } from "../src/core/atlas.js";
import { readPage } from "../src/core/pipeline.js";
import { buildDict, correctTokens } from "../src/core/dict.js";
import { decodeJpegOriented } from "./image_io.mjs";

function distance(a, b) {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length];
}

function downscale(rgba, w, h, maxDim) {
  const scale = Math.min(1, maxDim / Math.max(w, h));
  if (scale >= 1) return { data: rgba, w, h };
  const dw = Math.round(w * scale),
    dh = Math.round(h * scale);
  const out = new Uint8Array(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(h - 1, Math.floor((y + 0.5) / scale));
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(w - 1, Math.floor((x + 0.5) / scale));
      const si = (sy * w + sx) * 4,
        di = (y * dw + x) * 4;
      out[di] = rgba[si];
      out[di + 1] = rgba[si + 1];
      out[di + 2] = rgba[si + 2];
      out[di + 3] = rgba[si + 3];
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

function cropHeader(img, frac = 0.06) {
  const y0 = Math.round(img.h * frac);
  const h = img.h - y0;
  const data = new Uint8Array(img.w * h);
  for (let y = 0; y < h; y++) {
    data.set(img.data.subarray((y0 + y) * img.w, (y0 + y + 1) * img.w), y * img.w);
  }
  return { w: img.w, h, data };
}

function cropSides(img, frac = 0.06) {
  const x0 = Math.round(img.w * frac), x1 = Math.round(img.w * (1 - frac));
  const w = x1 - x0;
  const data = new Uint8Array(w * img.h);
  for (let y = 0; y < img.h; y++) {
    data.set(img.data.subarray(y * img.w + x0, y * img.w + x1), y * w);
  }
  return { w, h: img.h, data };
}

const translit = (w) =>
  w
    .toUpperCase()
    .replace(/Ä/g, "AE")
    .replace(/Ö/g, "OE")
    .replace(/Ü/g, "UE")
    .replace(/ß/gi, "SS")
    .replace(/[^A-Z\s]/g, " ");
const norm = (s) => translit(s).replace(/\s+/g, " ").trim();

const { imgDir, atlasPath, items, maxDim, dictPayload } = workerData;
const atlas = prepareAtlas(JSON.parse(fs.readFileSync(atlasPath, "utf8")));
const dict = dictPayload
  ? buildDict(dictPayload.words, dictPayload.custom, dictPayload.nounBits)
  : null;

const out = [];
for (const item of items) {
  const t0 = Date.now();
  const raw = await decodeJpegOriented(path.join(imgDir, item.file));
  const small = downscale(raw.data, raw.width, raw.height, maxDim);
  let img = gray(small.w, small.h, small.data);
  img = cropSides(cropHeader(img));

  const res = readPage(img, atlas, item.font);
  let got = norm(res?.text || "");
  if (dict && got) {
    const toks = got.split(" ").filter(Boolean);
    got = norm(correctTokens(toks, dict).join(" "));
  }
  const want = item.want;
  const cer = want.length ? distance(got, want) / want.length : 1;
  out.push({
    file: item.file,
    font: item.font,
    brief: item.brief,
    cer,
    sec: (Date.now() - t0) / 1000,
    lines: res?.lines?.length ?? 0,
    conf: res?.confidence ?? 0,
    got,
    want,
  });
}
parentPort.postMessage(out);

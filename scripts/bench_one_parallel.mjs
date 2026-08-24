// Ein Foto, Zeilen parallel auf allen Kernen.
//
//   node scripts/bench_one_parallel.mjs img/real/Taluz-15pt-B2.jpg
//   node scripts/bench_one_parallel.mjs img/real/Runen-15pt-B2.jpg --dict

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import { prepareAtlas } from "../src/core/atlas.js";
import { ambiguityMap } from "../src/core/atlas.js";
import { binarize, despeckle, estimateSkew, normalizePolarity, rotate } from "../src/core/image.js";
import { cropLine, findLines, fontExtent } from "../src/core/lines.js";
import { buildDict, correctTokens } from "../src/core/dict.js";
import { decodeJpegOriented } from "./image_io.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const maxDim = 1100;
const useDict = process.argv.includes("--dict");
const fileArg = process.argv.slice(2).find((a) => !a.startsWith("-"))
  || "img/real/Taluz-15pt-B2.jpg";
const filePath = path.isAbsolute(fileArg) ? fileArg : path.join(root, fileArg);
const base = path.basename(filePath);

const m = base.match(/^(.+)-(\d+)pt-(A1|B2)\.jpg$/i);
if (!m) {
  console.error("Dateiname muss {Font}-{pt}-{A1|B2}.jpg sein:", base);
  process.exit(1);
}
const font = `Phoenix-${m[1]}`;
const brief = m[3].toUpperCase();

const translit = (w) =>
  w.toUpperCase()
    .replace(/Ä/g, "AE").replace(/Ö/g, "OE").replace(/Ü/g, "UE")
    .replace(/ß/gi, "SS").replace(/[^A-Z\s]/g, " ");
const norm = (s) => translit(s).replace(/\s+/g, " ").trim();

function distance(a, b) {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

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

const want = norm(fs.readFileSync(path.join(root, "test material", brief), "utf8"));
const atlas = prepareAtlas(JSON.parse(fs.readFileSync(path.join(root, "src", "atlas.json"), "utf8")));
if (!atlas.fonts[font]) {
  console.error("Font nicht im Atlas:", font);
  process.exit(1);
}

const tAll = Date.now();
const raw = await decodeJpegOriented(filePath);
const small = downscale(raw.data, raw.width, raw.height, maxDim);
let img = gray(small.w, small.h, small.data);
img = cropSides(cropHeader(img));

let bin = normalizePolarity(binarize(img));
const skew = estimateSkew(bin);
const straight = rotate(bin, skew);
const lines = findLines(straight);

const fontObj = atlas.fonts[font];
const extent = fontExtent(fontObj, atlas.emPx);
let advSum = 0, advN = 0;
for (const g of Object.values(fontObj.letters)) {
  if (g.adv) { advSum += g.adv; advN++; }
}
const avgAdvEm = advSum / Math.max(advN, 1);

// Zeilenbilder serialisierbar machen (ink als Buffer).
const jobs = lines.map((line, i) => {
  const cropped = cropLine(straight, line);
  return {
    i,
    w: cropped.w,
    h: cropped.h,
    ink: Buffer.from(cropped.ink),
    inkTop: cropped.inkTop,
    inkBottom: cropped.inkBottom,
    box: { x0: line.x0, y0: line.y0, x1: line.x1, y1: line.y1 },
  };
});

const nWorkers = Math.max(1, Math.min(os.cpus().length, Math.max(jobs.length, 1)));
const chunks = Array.from({ length: nWorkers }, () => []);
jobs.forEach((j, i) => chunks[i % nWorkers].push(j));

console.log(
  `${base}  ${font}  ${raw.width}x${raw.height} → ${img.w}x${img.h}  ` +
  `${jobs.length} Zeilen auf ${nWorkers} Worker`,
);

const tDec = Date.now();
const partials = (
  await Promise.all(
    chunks.map(
      (chunk) =>
        new Promise((resolve, reject) => {
          if (!chunk.length) return resolve([]);
          const w = new Worker(path.join(here, "bench_one_line_worker.mjs"), {
            workerData: {
              atlasPath: path.join(root, "src", "atlas.json"),
              font,
              avgAdvEm,
              extent,
              alphabet: atlas.alphabet,
              emPx: atlas.emPx,
              lines: chunk,
            },
          });
          w.on("message", resolve);
          w.on("error", reject);
        }),
    ),
  )
).flat();

partials.sort((a, b) => a.i - b.i);
const decoded = partials.filter((p) => p.text);
const text = decoded.map((p) => p.text).join("\n");
const confidence = decoded.length
  ? decoded.reduce((s, p) => s + p.score, 0) / decoded.length
  : 0;

let got = norm(text);
if (useDict) {
  const gen = path.join(root, "src", "generated-dict.js");
  if (!fs.existsSync(gen)) {
    console.error("generated-dict.js fehlt — node build.mjs");
    process.exit(1);
  }
  const mod = await import("../src/generated-dict.js");
  const dict = buildDict(mod.DICT_WORDS, mod.CUSTOM_WORDS, mod.DICT_NOUN_BITS);
  got = norm(correctTokens(got.split(" ").filter(Boolean), dict).join(" "));
}

const decSec = (Date.now() - tDec) / 1000;
const allSec = (Date.now() - tAll) / 1000;
const cer = want.length ? distance(got, want) / want.length : 1;
const amb = ambiguityMap(fontObj);

console.log(`CER ${(cer * 100).toFixed(1)}%  conf ${confidence.toFixed(2)}  skew ${skew.toFixed(2)}°`);
console.log(`Decode ${decSec.toFixed(1)}s  gesamt ${allSec.toFixed(1)}s  (${nWorkers} Kerne, ~${(jobs.length / Math.max(decSec, 0.01)).toFixed(1)} Zeilen/s)`);
console.log(`Zeilen erkannt ${decoded.length}/${jobs.length}  Mehrdeutig ${Object.keys(amb).length ? JSON.stringify(fontObj.ambiguous) : "—"}`);
console.log("--- soll (120) ---");
console.log(want.slice(0, 120));
console.log("--- ist  (120) ---");
console.log(got.slice(0, 120));
console.log("--- ist (voll) ---");
console.log(got);

// Misst ein CRNN-ONNX-Modell gegen ein echtes Foto.
//
//   node scripts/bench_crnn.mjs img/real/Taluz-15pt-B2.jpg models/taluz-crnn.onnx

import fs from "node:fs";
import path from "node:path";
import jpeg from "jpeg-js";
import * as ort from "onnxruntime-node";

import { binarize, estimateSkew, normalizePolarity, rotate } from "../src/core/image.js";
import { cropLine, findLines } from "../src/core/lines.js";
import { decodeJpegOriented } from "./image_io.mjs";

const root = path.resolve(import.meta.dirname, "..");
const photoArg = process.argv[2] || "img/real/Taluz-15pt-B2.jpg";
const modelArg = process.argv[3] || "models/taluz-crnn.onnx";
const photoPath = path.resolve(root, photoArg);
const modelPath = path.resolve(root, modelArg);
const maxDim = Number(process.argv[4] || 1100);
const linesOnly = process.argv.includes("--lines-only");
const debugLines = process.argv.includes("--debug-lines");
const useDict = process.argv.includes("--dict");
const height = 48;
const chars = " ABCDEFGHIJKLMNOPQRSTUVWXYZ";

const match = path.basename(photoPath).match(/^(.+)-(\d+)pt-(A1|B2)\.jpg$/i);
if (!match) throw new Error(`Unbekanntes Dateischema: ${path.basename(photoPath)}`);
const fontName = `Phoenix-${match[1]}`;
const truthName = match[3].toUpperCase();

const ambiguity = {
  "Phoenix-Taluz": { Q: "T", V: "L" },
  "Phoenix-Lem-Kai": { Z: "P" },
  "Phoenix-Nalya": { N: "J" },
};

function normalize(text) {
  return text
    .toUpperCase()
    .replaceAll("Ä", "AE")
    .replaceAll("Ö", "OE")
    .replaceAll("Ü", "UE")
    .replaceAll("ß", "SS")
    .replace(/[^A-Z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function canonical(text) {
  const map = ambiguity[fontName] || {};
  return [...text].map((ch) => map[ch] || ch).join("");
}

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

function downscale(rgba, w, h, limit) {
  const scale = Math.min(1, limit / Math.max(w, h));
  if (scale >= 1) return { data: rgba, w, h };
  const dw = Math.round(w * scale), dh = Math.round(h * scale);
  const out = new Uint8Array(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(h - 1, Math.floor((y + 0.5) / scale));
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(w - 1, Math.floor((x + 0.5) / scale));
      const si = (sy * w + sx) * 4, di = (y * dw + x) * 4;
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

/** Entfernt die lateinische Titelzeile oben. */
function cropHeader(img, fraction = 0.06) {
  const y0 = Math.round(img.h * fraction);
  const h = img.h - y0;
  const data = new Uint8Array(img.w * h);
  for (let y = 0; y < h; y++) {
    data.set(img.data.subarray((y0 + y) * img.w, (y0 + y + 1) * img.w), y * img.w);
  }
  return { w: img.w, h, data };
}

/** Simuliert einen engen UI-Crop: dunkle Tisch-/Papierränder entfernen. */
function cropSides(img, fraction = 0.06) {
  const x0 = Math.round(img.w * fraction);
  const x1 = Math.round(img.w * (1 - fraction));
  const w = x1 - x0;
  const data = new Uint8Array(w * img.h);
  for (let y = 0; y < img.h; y++) {
    data.set(img.data.subarray(y * img.w + x0, y * img.w + x1), y * w);
  }
  return { w, h: img.h, data };
}

/** Binaere Zeile auf 48px Hoehe skalieren; Tinte=1, Papier=0. */
function prepareLine(line) {
  const scale = height / Math.max(line.h, 1);
  const innerW = Math.max(8, Math.round(line.w * scale));
  const width = Math.ceil((innerW + 8) / 4) * 4;
  const data = new Float32Array(height * width);
  for (let y = 0; y < height; y++) {
    const sy = Math.min(line.h - 1, Math.floor((y + 0.5) / scale));
    for (let x = 0; x < innerW; x++) {
      const sx = Math.min(line.w - 1, Math.floor((x + 0.5) / scale));
      data[y * width + x + 4] = line.ink[sy * line.w + sx] ? 1 : 0;
    }
  }
  return { data, width };
}

function greedy(logits, dims) {
  const [, time, classes] = dims;
  const out = [];
  let previous = -1;
  for (let t = 0; t < time; t++) {
    let best = 0, bestValue = -Infinity;
    for (let c = 0; c < classes; c++) {
      const value = logits[t * classes + c];
      if (value > bestValue) {
        bestValue = value;
        best = c;
      }
    }
    if (best !== 0 && best !== previous) out.push(chars[best - 1]);
    previous = best;
  }
  return out.join("").replace(/\s+/g, " ").trim();
}

if (!linesOnly && !fs.existsSync(modelPath)) throw new Error(`Modell fehlt: ${modelPath}`);
const raw = await decodeJpegOriented(photoPath);
const small = downscale(raw.data, raw.width, raw.height, maxDim);
let img = cropSides(cropHeader(gray(small.w, small.h, small.data)));

const tPrep = performance.now();
let binary = normalizePolarity(binarize(img));
const skew = estimateSkew(binary);
binary = rotate(binary, skew);
const boxes = findLines(binary);
const lines = boxes.map((box) => cropLine(binary, box));
const prepMs = performance.now() - tPrep;

if (debugLines) {
  const gap = 6;
  const montageW = Math.max(...lines.map((line) => line.w), 1);
  const montageH = lines.reduce((sum, line) => sum + line.h + gap, gap);
  const rgba = Buffer.alloc(montageW * montageH * 4, 205);
  for (let p = 3; p < rgba.length; p += 4) rgba[p] = 255;
  let y0 = gap;
  for (const line of lines) {
    for (let y = 0; y < line.h; y++) {
      for (let x = 0; x < line.w; x++) {
        const p = ((y0 + y) * montageW + x) * 4;
        if (line.ink[y * line.w + x]) {
          rgba[p] = rgba[p + 1] = rgba[p + 2] = 0;
        } else {
          rgba[p] = rgba[p + 1] = rgba[p + 2] = 255;
        }
      }
    }
    y0 += line.h + gap;
  }
  const out = path.join(root, "ml", "checkpoints", `${path.parse(photoPath).name}-lines.jpg`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, jpeg.encode({ data: rgba, width: montageW, height: montageH }, 90).data);
  console.log(`Zeilenmontage: ${out}`);
}

if (linesOnly) {
  console.log(`${path.basename(photoPath)}: ${lines.length} Zeilen, Vorbereitung ${(prepMs / 1000).toFixed(2)}s`);
  process.exit(0);
}

const session = await ort.InferenceSession.create(modelPath, {
  executionProviders: ["cpu"],
  graphOptimizationLevel: "all",
});
const outputs = [];
const lineTimes = [];
for (let i = 0; i < lines.length; i++) {
  const input = prepareLine(lines[i]);
  const tensor = new ort.Tensor("float32", input.data, [1, 1, height, input.width]);
  const t0 = performance.now();
  const result = await session.run({ image: tensor });
  lineTimes.push(performance.now() - t0);
  outputs.push(greedy(result.logits.data, result.logits.dims));
}

const got = normalize(outputs.join("\n"));
const want = normalize(fs.readFileSync(path.join(root, "test material", truthName), "utf8"));
const exactCer = distance(got, want) / Math.max(want.length, 1);
const ambCer = distance(canonical(got), canonical(want)) / Math.max(want.length, 1);
let fixed = "", fixedCer = 0, fixedAmbCer = 0, dictMs = 0;
if (useDict) {
  const [{ buildDict, correctTokens }, generated] = await Promise.all([
    import("../src/core/dict.js"),
    import("../src/generated-dict.js"),
  ]);
  const tDict = performance.now();
  const dict = buildDict(generated.DICT_WORDS, generated.CUSTOM_WORDS, generated.DICT_NOUN_BITS);
  fixed = normalize(correctTokens(got.split(" ").filter(Boolean), dict).join(" "));
  dictMs = performance.now() - tDict;
  fixedCer = distance(fixed, want) / Math.max(want.length, 1);
  fixedAmbCer = distance(canonical(fixed), canonical(want)) / Math.max(want.length, 1);
}
const inferMs = lineTimes.reduce((a, b) => a + b, 0);

console.log(`${path.basename(photoPath)}  ${raw.width}x${raw.height} → ${img.w}x${img.h}`);
console.log(`Modell: ${path.relative(root, modelPath)}  ${(fs.statSync(modelPath).size / 1024 / 1024).toFixed(2)} MB`);
console.log(`Zeilen: ${lines.length}  skew ${skew.toFixed(2)}°`);
console.log(
  `Zeit: Vorbereitung ${(prepMs / 1000).toFixed(2)}s  ` +
  `Inference ${(inferMs / 1000).toFixed(2)}s  ` +
  `(${(inferMs / Math.max(lines.length, 1)).toFixed(1)}ms/Zeile)`,
);
console.log(`CER exakt ${(exactCer * 100).toFixed(1)}%  Mehrdeutigkeits-bereinigt ${(ambCer * 100).toFixed(1)}%`);
if (useDict) {
  console.log(
    `CER + Wörterbuch ${(fixedCer * 100).toFixed(1)}%  ` +
    `bereinigt ${(fixedAmbCer * 100).toFixed(1)}%  Zeit ${(dictMs / 1000).toFixed(2)}s`,
  );
}
console.log("--- Zeilen ---");
outputs.forEach((text, i) => console.log(`${String(i + 1).padStart(2)}: ${text}`));
console.log("--- Soll (120) ---");
console.log(want.slice(0, 120));
console.log("--- Ist (120) ---");
console.log(got.slice(0, 120));
if (useDict) {
  console.log("--- Ist + Wörterbuch (120) ---");
  console.log(fixed.slice(0, 120));
}

// Misst CRNN-CER und Polaritaet auf den synthetischen Farbfaellen.

import fs from "node:fs";
import path from "node:path";
import * as ort from "onnxruntime-node";

import { binarizeAutoPolarity, estimateSkew, gray, rotate } from "../src/core/image.js";
import { cropLine, findLines } from "../src/core/lines.js";
import { decodeJpegOriented } from "./image_io.mjs";

const root = path.resolve(import.meta.dirname, "..");
const dir = path.join(root, "ml", "checkpoints", "color-cases");
const height = 48;
const chars = " ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const models = {
  "Phoenix-Gobsch": "models/gobsch-crnn.onnx",
  "Phoenix-Taluz": "models/taluz-crnn.onnx",
  "Phoenix-Xersesch": "models/xersesch-crnn.onnx",
};

function normalize(text) {
  return text.toUpperCase().replace(/[^A-Z\s]/g, " ").replace(/\s+/g, " ").trim();
}

function distance(a, b) {
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

function prepareLine(line) {
  const scale = height / Math.max(line.h, 1);
  const innerW = Math.max(8, Math.round(line.w * scale));
  const width = Math.ceil((innerW + 8) / 8) * 8;
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
      const v = logits[t * classes + c];
      if (v > bestValue) { bestValue = v; best = c; }
    }
    if (best !== 0 && best !== previous) out.push(chars[best - 1]);
    previous = best;
  }
  return out.join("").replace(/\s+/g, " ").trim();
}

const index = JSON.parse(fs.readFileSync(path.join(dir, "index.json"), "utf8"));
const sessions = new Map();

async function sessionFor(font) {
  if (!sessions.has(font)) {
    sessions.set(font, await ort.InferenceSession.create(path.join(root, models[font]), {
      executionProviders: ["cpu"],
      graphOptimizationLevel: "all",
    }));
  }
  return sessions.get(font);
}

console.log(
  "Schrift".padEnd(10) +
  "Fall".padEnd(20) +
  "dL".padStart(4) +
  " cov".padStart(6) +
  " inv".padStart(4) +
  " Z".padStart(3) +
  "  CER".padStart(7),
);

for (const item of index) {
  const raw = await decodeJpegOriented(path.join(dir, item.file));
  const img = gray(raw.width, raw.height, raw.data);
  const bin = binarizeAutoPolarity(img);
  const skew = estimateSkew(bin);
  const straight = rotate(bin, skew);
  const boxes = findLines(straight, { splitConnected: item.font !== "Phoenix-Runen" });
  const session = await sessionFor(item.font);
  const texts = [];
  for (const box of boxes) {
    const line = cropLine(straight, box);
    if (!line.w || !line.h) continue;
    const input = prepareLine(line);
    const tensor = new ort.Tensor("float32", input.data, [1, 1, height, input.width]);
    const result = await session.run({ image: tensor });
    const text = greedy(result.logits.data, result.logits.dims);
    if (text) texts.push(text);
  }
  const got = normalize(texts.join(" "));
  const want = normalize(item.truth);
  const cer = distance(got, want) / Math.max(want.length, 1);
  item.coverage = bin.coverage;
  item.inverted = !!bin.inverted;
  item.lines = boxes.length;
  item.cer = cer;
  item.got = got;
  console.log(
    item.font.replace("Phoenix-", "").padEnd(10) +
    item.case.padEnd(20) +
    String(item.delta).padStart(4) +
    ` ${(bin.coverage * 100).toFixed(0).padStart(4)}%` +
    (bin.inverted ? "  ja" : "   -") +
    String(boxes.length).padStart(3) +
    ` ${(cer * 100).toFixed(1).padStart(6)}%`,
  );
}

fs.writeFileSync(path.join(dir, "results.json"), JSON.stringify(index, null, 2));
const byCase = new Map();
for (const item of index) {
  const row = byCase.get(item.case) || { case: item.case, note: item.note, n: 0, cer: 0, inv: 0 };
  row.n++;
  row.cer += item.cer;
  row.inv += item.inverted ? 1 : 0;
  byCase.set(item.case, row);
}
console.log("\n=== Mittel ueber 3 Schriften ===");
for (const row of byCase.values()) {
  console.log(
    `${row.case.padEnd(20)} CER ${(row.cer / row.n * 100).toFixed(1).padStart(5)}%  ` +
    `invertiert ${row.inv}/${row.n}  ${row.note}`,
  );
}

// Zeilenweise Inferenz fuer das experimentelle Tiny-CRNN+CTC-Modell.

import { binarizeAutoPolarity, estimateSkew, rotate } from "./image.js";
import { cropLine, findLines } from "./lines.js";

const HEIGHT = 48;
const CHARS = " ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function prepareLine(line) {
  const scale = HEIGHT / Math.max(line.h, 1);
  const innerW = Math.max(8, Math.round(line.w * scale));
  const width = Math.ceil((innerW + 8) / 8) * 8;
  const data = new Float32Array(HEIGHT * width);
  for (let y = 0; y < HEIGHT; y++) {
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
  let confidence = 0;
  for (let t = 0; t < time; t++) {
    let best = 0, bestValue = -Infinity, second = -Infinity;
    for (let c = 0; c < classes; c++) {
      const value = logits[t * classes + c];
      if (value > bestValue) {
        second = bestValue;
        bestValue = value;
        best = c;
      } else if (value > second) {
        second = value;
      }
    }
    confidence += 1 / (1 + Math.exp(-(bestValue - second)));
    if (best !== 0 && best !== previous) out.push(CHARS[best - 1]);
    previous = best;
  }
  return {
    text: out.join("").replace(/\s+/g, " ").trim(),
    confidence: confidence / Math.max(time, 1),
  };
}

export async function readPageCrnn(img, ort, session, opts = {}) {
  const progress = opts.onProgress || (() => {});
  progress("prepare", { w: img.w, h: img.h });
  let binary = binarizeAutoPolarity(img);
  const skew = estimateSkew(binary);
  binary = rotate(binary, skew);

  const boxes = findLines(binary, {
    splitConnected: opts.font !== "Phoenix-Runen",
  });
  progress("lines", { total: boxes.length });
  const lines = [];
  for (let i = 0; i < boxes.length; i++) {
    progress("line", { i: i + 1, total: boxes.length });
    const line = cropLine(binary, boxes[i]);
    if (!line.w || !line.h) continue;
    const input = prepareLine(line);
    const tensor = new ort.Tensor("float32", input.data, [1, 1, HEIGHT, input.width]);
    const result = await session.run({ image: tensor });
    const decoded = greedy(result.logits.data, result.logits.dims);
    if (decoded.text) lines.push(decoded);
  }

  return {
    text: lines.map((line) => line.text).join("\n"),
    lines,
    confidence: lines.length
      ? lines.reduce((sum, line) => sum + line.confidence, 0) / lines.length
      : 0,
    skew,
  };
}

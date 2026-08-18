// Vergleicht CER und Zeit bei weniger Skalierungs-Schritten, um zu pruefen
// ob sich das ohne echten Genauigkeitsverlust einsparen laesst.

import fs from "node:fs";
import path from "node:path";
import { prepareAtlas } from "../src/core/atlas.js";
import { readPage } from "../src/core/pipeline.js";

const atlas = prepareAtlas(JSON.parse(fs.readFileSync("src/atlas.json", "utf8")));
const dataDir = path.join("test", "data");
const index = JSON.parse(fs.readFileSync(path.join(dataDir, "index.json"), "utf8"));

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
const norm = (s) => s.replace(/\s+/g, " ").trim().toUpperCase();

const items = index.filter((i) => i.font === "Phoenix-Runen" &&
  ["sauber", "leicht", "handyfoto"].includes(i.level));

const configs = [
  { label: "Standard (7+9)", opts: {} },
  { label: "Reduziert (5+5)", opts: { scale: { steps: 5, fineSteps: 5 } } },
  { label: "Minimal (4+4)", opts: { scale: { steps: 4, fineSteps: 4 } } },
];

for (const cfg of configs) {
  let totalCer = 0, totalMs = 0, n = 0;
  for (const item of items) {
    const buf = fs.readFileSync(path.join(dataDir, item.file));
    const img = { w: item.w, h: item.h, data: new Uint8Array(buf) };
    const t0 = Date.now();
    const res = readPage(img, atlas, item.font, cfg.opts);
    totalMs += Date.now() - t0;
    const cer = distance(norm(res.text), norm(item.text)) / Math.max(1, norm(item.text).length);
    totalCer += cer;
    n++;
  }
  console.log(`${cfg.label.padEnd(20)} CER ${((totalCer / n) * 100).toFixed(1)}%   ${(totalMs / n / 1000).toFixed(1)}s/Brief   (n=${n})`);
}

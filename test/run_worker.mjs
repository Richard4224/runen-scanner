// Worker-Thread fuer run_parallel.js: dekodiert eine Teilmenge der Testbriefe
// und liefert pro Brief { font, level, cer } zurueck an den Hauptthread.

import fs from "node:fs";
import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";

import { prepareAtlas } from "../src/core/atlas.js";
import { readPage } from "../src/core/pipeline.js";

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
const norm = (s) => s.replace(/\s+/g, " ").trim().toUpperCase();

const { dataDir, atlasPath, items } = workerData;
const atlas = prepareAtlas(JSON.parse(fs.readFileSync(atlasPath, "utf8")));

const out = [];
for (const item of items) {
  const buf = fs.readFileSync(path.join(dataDir, item.file));
  const img = { w: item.w, h: item.h, data: new Uint8Array(buf) };
  const res = readPage(img, atlas, item.font);
  const got = norm(res.text);
  const want = norm(item.text);
  const cer = want.length ? distance(got, want) / want.length : 1;
  out.push({ font: item.font, level: item.level, size: item.size, text: item.text, got: res.text, cer });
}
parentPort.postMessage(out);
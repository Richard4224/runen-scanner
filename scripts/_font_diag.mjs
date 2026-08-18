// Atlas-Metriken + ein sauberer Testbrief je Font. Ausgabe klein halten.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { prepareAtlas } from "../src/core/atlas.js";
import { readPage } from "../src/core/pipeline.js";
import { fontExtent } from "../src/core/lines.js";
import { binarize, estimateSkew, normalizePolarity, rotate } from "../src/core/image.js";
import { findLines, cropLine, scaleCandidates } from "../src/core/lines.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const outPath = path.join(here, "_font_diag_out.txt");
const lines = [];
const log = (s = "") => lines.push(s);

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

const atlas = prepareAtlas(JSON.parse(fs.readFileSync(path.join(root, "src", "atlas.json"), "utf8")));
const index = JSON.parse(fs.readFileSync(path.join(root, "test", "data", "index.json"), "utf8"));

log("=== ATLAS ===");
log(`emPx=${atlas.emPx}  fonts=${Object.keys(atlas.fonts).join(", ")}`);
for (const [name, font] of Object.entries(atlas.fonts)) {
  const letters = Object.entries(font.letters);
  const advs = letters.map(([, g]) => g.adv);
  const hs = letters.map(([, g]) => g.h);
  const empty = letters.filter(([, g]) => !g.w || !g.h || !g.pixels?.length).map(([ch]) => ch);
  const hashes = new Map();
  for (const [ch, g] of letters) {
    const h = `${g.w}x${g.h}:${g.pixels[0]},${g.pixels[g.pixels.length >> 1]},${g.pixels.at(-1)}:${g.adv}`;
    hashes.set(h, (hashes.get(h) || "") + ch);
  }
  const dup = [...hashes.values()].filter((s) => s.length > 1);
  const ext = fontExtent(font, atlas.emPx);
  const minAdv = Math.min(...advs), maxAdv = Math.max(...advs);
  log(
    `${name.padEnd(22)} n=${letters.length} unique~${hashes.size} ` +
    `adv ${minAdv.toFixed(2)}-${maxAdv.toFixed(2)} (spread ${(maxAdv / minAdv).toFixed(2)}x) ` +
    `h ${Math.min(...hs)}-${Math.max(...hs)}px  extentH=${ext.height.toFixed(3)} medH=${ext.medianH.toFixed(3)} ` +
    `amb=[${(font.ambiguous || []).join(",")}]` +
    (empty.length ? ` EMPTY=${empty.join("")}` : "") +
    (dup.length ? ` dups=${dup.join("/")}` : ""),
  );
}

log("\n=== SAUBER, 1 Brief je Font ===");
const dataDir = path.join(root, "test", "data");
const seen = new Set();
for (const item of index) {
  if (item.level !== "sauber" || seen.has(item.font)) continue;
  seen.add(item.font);
  const buf = fs.readFileSync(path.join(dataDir, item.file));
  const img = { w: item.w, h: item.h, data: new Uint8Array(buf) };
  const font = atlas.fonts[item.font];
  const extent = fontExtent(font, atlas.emPx);
  const bin = normalizePolarity(binarize(img));
  const skew = estimateSkew(bin);
  const straight = rotate(bin, skew);
  const found = findLines(straight);
  const lineInfo = found.map((l) => {
    const img2 = cropLine(straight, l);
    const inkH = img2.inkBottom - img2.inkTop;
    const em0 = inkH / extent.height;
    const cands = scaleCandidates(img2, extent);
    return `${inkH}px inkH em0=${em0.toFixed(1)} trueSize=${item.size} cands=${cands[0]?.em.toFixed(1)}..${cands.at(-1)?.em.toFixed(1)}`;
  });
  const res = readPage(img, atlas, item.font);
  const got = norm(res.text);
  const want = norm(item.text);
  const cer = want.length ? distance(got, want) / want.length : 1;
  log(`${item.font} file=${item.file} ${item.w}x${item.h} size=${item.size}`);
  log(`  cov=${bin.coverage.toFixed(3)} inv=${!!bin.inverted} skew=${skew.toFixed(2)} lines=${found.length}`);
  for (const li of lineInfo) log(`  ${li}`);
  log(`  CER ${(cer * 100).toFixed(1)}%  score=${res.confidence.toFixed(3)}`);
  log(`  soll: ${want}`);
  log(`  ist : ${got}`);
}

fs.writeFileSync(outPath, lines.join("\n"), "utf8");
console.log(`wrote ${outPath} (${lines.length} lines)`);

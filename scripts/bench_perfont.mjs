// Zeitmessung je Schrift auf einem festen Ausschnitt eines echten Fotos --
// um zu pruefen, ob eine einzelne Schrift bei bestimmtem Bildinhalt
// unverhaeltnismaessig lange braucht (Pfad-Explosion) oder ob alle 8
// gleichmaessig teuer sind.

import fs from "node:fs";
import jpeg from "jpeg-js";
import { prepareAtlas } from "../src/core/atlas.js";
import { readPage } from "../src/core/pipeline.js";
import { findLines } from "../src/core/lines.js";
import { binarize, estimateSkew, normalizePolarity, rotate } from "../src/core/image.js";

const atlas = prepareAtlas(JSON.parse(fs.readFileSync("src/atlas.json", "utf8")));
const raw = jpeg.decode(fs.readFileSync("img/ABC test bild gerade.jpg"), { useTArray: true });

// Ausschnitt in Originalpixeln, wie im e2e-Test berechnet: x 120..1000, y 988..1198
const [x0, y0, x1, y1] = [120, 988, 1000, 1198];
const cw = x1 - x0, ch = y1 - y0;
const out = new Uint8Array(cw * ch * 4);
for (let y = 0; y < ch; y++) {
  for (let x = 0; x < cw; x++) {
    const si = ((y + y0) * raw.width + (x + x0)) * 4, di = (y * cw + x) * 4;
    out[di] = raw.data[si]; out[di+1]=raw.data[si+1]; out[di+2]=raw.data[si+2]; out[di+3]=raw.data[si+3];
  }
}
function gray(w, h, rgba) {
  const g = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < g.length; i++, p += 4) g[i] = (rgba[p]*77+rgba[p+1]*150+rgba[p+2]*29)>>8;
  return { w, h, data: g };
}
const img = gray(cw, ch, out);
console.log(`Ausschnitt ${cw}x${ch}`);

const bin = normalizePolarity(binarize(img));
const skew = estimateSkew(bin);
const straight = rotate(bin, skew);
const lines = findLines(straight);
console.log(`Zeilen: ${lines.length}`, lines.map(l => `${l.x1-l.x0}x${l.y1-l.y0}`).join(", "));

for (const font of Object.keys(atlas.fonts)) {
  const t0 = Date.now();
  const res = readPage(img, atlas, font);
  console.log(`${font.padEnd(22)} ${((Date.now()-t0)/1000).toFixed(1)}s  conf=${res.confidence.toFixed(2)}  lines=${res.lines.length}`);
}

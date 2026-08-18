// Baut aus einer bekannten sauberen .raw-Testzeile (test/data) ein JPEG,
// damit der komplette Browserpfad (Dateiauswahl -> Canvas -> Worker) an
// Material mit bekanntem Klartext geprueft werden kann, unabhaengig von der
// Unschaerfe/dem Chaos echter Handyfotos.

import fs from "node:fs";
import path from "node:path";
import jpeg from "jpeg-js";

const dataDir = path.join("test", "data");
const index = JSON.parse(fs.readFileSync(path.join(dataDir, "index.json"), "utf8"));
const item = index.find((i) => i.font === (process.argv[2] || "Phoenix-Runen") && i.level === "sauber");
console.log("Nehme:", item.file, item.font, item.text);

const buf = fs.readFileSync(path.join(dataDir, item.file));
const { w, h } = item;
const rgba = new Uint8Array(w * h * 4);
for (let i = 0; i < w * h; i++) {
  const v = buf[i];
  rgba[i * 4] = v; rgba[i * 4 + 1] = v; rgba[i * 4 + 2] = v; rgba[i * 4 + 3] = 255;
}
const out = jpeg.encode({ data: rgba, width: w, height: h }, 95);
fs.mkdirSync("build", { recursive: true });
fs.writeFileSync("build/clean_test.jpg", out.data);
console.log("Geschrieben: build/clean_test.jpg", w + "x" + h);

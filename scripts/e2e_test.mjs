// Smoke-Test der gebauten dist/index.html mit echtem WebKit (Safari-Engine):
// Bild waehlen -> Rahmen ziehen -> Sprache waehlen -> entschluesseln -> Ergebnis pruefen.
// Laeuft ueber file://, exakt wie am Con auf dem Handy.

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { webkit } from "playwright";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const distFile = pathToFileURL(path.join(root, "dist", "index.html")).href;
const photoArg = process.argv[2] || "ABC test bild gerade.jpg";
const photo = path.isAbsolute(photoArg) || photoArg.includes("/") || photoArg.includes("\\")
  ? path.join(root, photoArg)
  : path.join(root, "img", photoArg);
const font = process.argv[3]; // optional: exakter Font-Wert, sonst 1. Eintrag

const browser = await webkit.launch();
const page = await browser.newPage({ viewport: { width: 430, height: 900 } });
page.on("console", (m) => console.log("[console]", m.text()));
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
page.on("requestfailed", (r) => console.log("[requestfailed]", r.url(), r.failure()?.errorText));

console.log("Öffne", distFile);
await page.goto(distFile);
console.log("Titel:", await page.title());

const [fileChooser] = await Promise.all([
  page.waitForEvent("filechooser"),
  page.click("#pick-btn"),
]);
await fileChooser.setFiles(photo);

await page.waitForSelector("#screen-crop.active", { timeout: 10000 });
console.log("Crop-Screen aktiv. Ziehe Rahmen enger um den Runentext …");

// Rahmen per echtem Drag auf den erkennbaren Textbereich einschraenken
// (grobe, im Vorfeld am Foto abgelesene Position).
const box = await page.locator("#crop-wrap").boundingBox();
const nw = await page.locator(".handle.nw").boundingBox();
const se = await page.locator(".handle.se").boundingBox();

async function dragHandle(sel, fromX, fromY, toX, toY) {
  await page.mouse.move(fromX, fromY);
  await page.mouse.down();
  await page.mouse.move(toX, toY, { steps: 5 });
  await page.mouse.up();
}

const [fx0, fy0, fx1, fy1] = (process.argv[4] || "0.03,0.33,0.99,0.57").split(",").map(Number);
await dragHandle(".handle.nw", nw.x + 8, nw.y + 8, box.x + box.width * fx0, box.y + box.height * fy0);
await dragHandle(".handle.se", se.x - 8, se.y - 8, box.x + box.width * fx1, box.y + box.height * fy1);

if (font) await page.selectOption("#font-select", font);

const t0 = Date.now();
await page.click("#crop-go");
await page.waitForSelector("#screen-loading.active", { timeout: 5000 });
console.log("Entschlüsselung läuft (Worker) …");

await page.waitForSelector("#screen-result.active", { timeout: 5 * 60 * 1000 });
const dt = ((Date.now() - t0) / 1000).toFixed(1);

const meta = await page.locator("#result-meta").innerText().catch(() => "");
const text = await page.locator("#result-text").innerText().catch(() => "");
const err = await page.locator("#error-box").innerText().catch(() => "");
const dictLegend = await page.locator("#dict-legend").innerText().catch(() => "");

console.log(`\nDauer: ${dt}s`);
console.log("Meta:", meta);
console.log("Fehler:", err);
console.log("Text (Wörterbuch an):\n" + text);
console.log("Wörterbuch-Änderungen:", dictLegend || "(keine)");

await page.uncheck("#dict-toggle").catch(() => {});
const rawText = await page.locator("#result-text").innerText().catch(() => "");
console.log("Text (Wörterbuch aus):\n" + rawText);

await browser.close();

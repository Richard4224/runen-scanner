// Prueft, dass dist/index.html WIRKLICH alleine funktioniert -- kopiert sie in
// einen leeren Ordner (keine Geschwisterdateien) und laedt sie dort.
import { webkit } from "playwright";
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "runen-isolation-"));
fs.copyFileSync("dist/index.html", path.join(tmp, "index.html"));
console.log("Isolierter Ordner:", tmp);
console.log("Enthält nur:", fs.readdirSync(tmp));

const url = pathToFileURL(path.join(tmp, "index.html")).href;
const browser = await webkit.launch();
const page = await browser.newPage();
page.on("requestfailed", (r) => console.log("[requestfailed]", r.url()));
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
await page.goto(url);
console.log("Titel:", await page.title());
console.log("Start-Screen sichtbar:", await page.locator("#screen-start.active").isVisible());
await browser.close();

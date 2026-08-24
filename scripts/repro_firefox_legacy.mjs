// Reproduziert den mobilen Legacy-Ablauf mit einem echten Foto in Firefox.

import path from "node:path";
import { firefox } from "playwright";

const root = path.resolve(import.meta.dirname, "..");
const image = path.resolve(root, process.argv[2] || "img/real/bug-test-bild1.jpg");
const url = process.argv[3] || "https://runen-uebersetzer.pages.dev/";
const timeoutMs = Number(process.argv[4] || 120_000);

const browser = await firefox.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 412, height: 915 },
  userAgent:
    "Mozilla/5.0 (Android 14; Mobile; rv:142.0) Gecko/142.0 Firefox/142.0",
});
const page = await context.newPage();
page.on("pageerror", (error) => console.log("PAGEERROR", error.message));
page.on("console", (msg) => {
  if (msg.type() === "error" || msg.type() === "warning") {
    console.log(`CONSOLE ${msg.type()}`, msg.text());
  }
});

try {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.setInputFiles("#file-input", image);
  await page.waitForSelector("#screen-crop.active", { timeout: 15_000 });
  await page.selectOption("#font-select", "Phoenix-Runen");
  await page.uncheck("#crnn-toggle");
  await page.click("#crop-go");

  const started = Date.now();
  let last = "";
  while (Date.now() - started < timeoutMs) {
    const state = await Promise.race([
      page.evaluate(() => ({
        loading: document.querySelector("#screen-loading.active") !== null,
        result: document.querySelector("#screen-result.active") !== null,
        detail: document.querySelector("#loading-detail")?.textContent || "",
        time: document.querySelector("#loading-time")?.textContent || "",
        error: document.querySelector("#error-box")?.textContent || "",
        text: document.querySelector("#result-text")?.textContent?.slice(0, 100) || "",
        meta: document.querySelector("#result-meta")?.textContent || "",
        dict: document.querySelector("#dict-legend")?.textContent || "",
        dictCancel: !document.querySelector("#dict-cancel")?.classList.contains("hidden"),
      })),
      new Promise((resolve) => setTimeout(() => resolve({ blocked: true }), 2_000)),
    ]);
    const line = JSON.stringify(state);
    if (line !== last) {
      console.log(`${((Date.now() - started) / 1000).toFixed(1)}s`, line);
      last = line;
    }
    if (state.result) {
      if (!state.dictCancel) {
        await page.uncheck("#dict-toggle");
        await page.check("#dict-toggle");
        await page.waitForSelector("#dict-cancel:not(.hidden)", { timeout: 2_000 });
      }
      await page.click("#dict-cancel");
      console.log("Wörterbuch-Abbruch reagiert");
      break;
    }
    if (state.blocked) {
      console.log("HAUPTTHREAD reagiert mindestens 2s nicht");
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
} finally {
  await browser.close();
}

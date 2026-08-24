// Wörterbuchkorrektur außerhalb des UI-Threads. Der Hauptthread kann diesen
// Worker jederzeit terminieren, ohne dass Navigation oder Abbrechen einfriert.

import { CUSTOM_WORDS, DICT_NOUN_BITS, DICT_WORDS } from "./generated-dict.js";
import { buildDict, correctTokens, formatWord } from "./core/dict.js";

const dict = buildDict(DICT_WORDS, CUSTOM_WORDS, DICT_NOUN_BITS);

self.onmessage = (ev) => {
  const { id, text } = ev.data;
  try {
    const lines = String(text || "").split("\n");
    const output = [];
    const changed = [];
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i].trim().split(/\s+/).filter(Boolean);
      const fixed = correctTokens(raw, dict);
      const formatted = fixed.map((word, j) => formatWord(word, dict, j === 0));
      output.push(formatted.join(" "));
      if (fixed.join(" ") !== raw.join(" ") && changed.length < 20) {
        changed.push([raw.join(" "), fixed.join(" ")]);
      }
      self.postMessage({ id, progress: true, i: i + 1, total: lines.length });
    }
    self.postMessage({ id, ok: true, text: output.join("\n"), changed });
  } catch (error) {
    self.postMessage({ id, ok: false, error: String(error?.message || error) });
  }
};

// Laedt atlas.json und packt die base64-Bitmaps in Uint8Array aus.

function fromBase64(s) {
  if (!s) return new Uint8Array(0);
  if (typeof atob === "function") {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(s, "base64"));
}

export function prepareAtlas(raw) {
  const fonts = {};
  for (const [name, f] of Object.entries(raw.fonts)) {
    const letters = {};
    for (const [ch, g] of Object.entries(f.letters)) {
      letters[ch] = { ...g, pixels: fromBase64(g.bitmap) };
      delete letters[ch].bitmap;
    }
    fonts[name] = { letters, ambiguous: f.ambiguous || [] };
  }
  return { emPx: raw.emPx, alphabet: raw.alphabet, fonts };
}

/**
 * Runen, die in einer Sprache identisch aussehen, lassen sich prinzipiell
 * nicht auseinanderhalten -- dann beide Moeglichkeiten anzeigen statt raten.
 */
export function ambiguityMap(font) {
  const map = {};
  for (const group of font.ambiguous) {
    for (const ch of group) map[ch] = group.split("").join("/");
  }
  return map;
}

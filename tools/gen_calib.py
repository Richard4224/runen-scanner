"""Erzeugt Testzeilen mit exakt bekannter Geometrie.

Damit laesst sich die Bewertungsfunktion isoliert pruefen: Schriftgroesse,
Grundlinie und jede Schreibposition sind bekannt, es wird also nichts
geschaetzt. Klassifiziert der Decoder hier falsch, liegt es am
Bewertungsmass -- klassifiziert er richtig, liegt es an der Schaetzung.
"""
import json
import os

from PIL import Image, ImageDraw, ImageFont

from gen_atlas import charmap

FONT_DIR = os.path.join(os.path.dirname(__file__), "..")
OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "test", "calib")

TEXT = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
PANGRAM = "DERBOTEBRINGTNACHRICHTAUSDEMNORDENZWOELFKRUEGE"
SIZE = 64


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for f in os.listdir(OUT_DIR):
        os.remove(os.path.join(OUT_DIR, f))

    index = []
    for fname in sorted(os.listdir(FONT_DIR)):
        if not fname.endswith(".ttf"):
            continue
        name = fname[:-4]
        path = os.path.join(FONT_DIR, fname)
        offset, encoding = charmap(path)
        font = ImageFont.truetype(path, SIZE, encoding=encoding)
        ascent, descent = font.getmetrics()
        em = ascent + descent
        scale = SIZE / em          # Renderpixel je em

        for tag, text in (("alphabet", TEXT), ("satz", PANGRAM)):
            s = "".join(chr(offset + ord(c)) for c in text)
            pad = SIZE * 2
            w = int(font.getlength(s)) + 2 * pad
            h = SIZE * 4
            baseline = h // 2
            img = Image.new("L", (w, h), 255)
            ImageDraw.Draw(img).text((pad, baseline), s, font=font,
                                     fill=0, anchor="ls")

            pens = [pad + font.getlength(s[:i]) for i in range(len(text))]
            out = f"{name}_{tag}.raw"
            with open(os.path.join(OUT_DIR, out), "wb") as fh:
                fh.write(img.tobytes())
            index.append({
                "file": out, "w": w, "h": h, "font": name, "text": text,
                # em in Bildpixeln: so gross ist ein Geviert im Bild
                "em": SIZE / scale * scale / 1.0 if False else SIZE / (em / (em)) * 1.0,
                "emPx": SIZE * (em / em),
                "baseline": baseline,
                "pens": [round(p, 3) for p in pens],
            })

    # em in Bildpixeln ist schlicht die Renderpixelgroesse geteilt durch
    # (em-Einheiten pro Renderpixel) -- bei PIL entspricht size dem em-Quadrat
    for it in index:
        it["em"] = SIZE
        it.pop("emPx", None)

    with open(os.path.join(OUT_DIR, "index.json"), "w", encoding="utf-8") as fh:
        json.dump(index, fh, indent=1)
    print(f"{len(index)} Kalibrierzeilen -> {OUT_DIR}")


if __name__ == "__main__":
    main()

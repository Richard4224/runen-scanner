"""Einzelbuchstaben und Alphabetzeilen fuer die Zeichen-Diagnose.

Ausgabe: test/chars/*.raw + index.json
  isoliert   eine Rune allein, mit Rand -- Matching ohne Nachbarn
  alphabet   A-Z in einer Zeile -- Matching plus Vorschub/DP
"""
import json
import os
import sys

from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, os.path.dirname(__file__))
from gen_atlas import charmap
from gen_testdata import render

FONT_DIR = os.path.join(os.path.dirname(__file__), "..")
OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "test", "chars")
ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
FONTS = [
    "Phoenix-Runen", "Phoenix-Taluz", "Phoenix-Gobsch", "Phoenix-Lacrimat",
    "Phoenix-Xersesch", "Phoenix-Nalya", "Phoenix-Nalya-Shirin", "Phoenix-Lem-Kai",
]
SIZE = 56


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for f in os.listdir(OUT_DIR):
        os.remove(os.path.join(OUT_DIR, f))

    index = []
    n = 0
    for fname in FONTS:
        path = os.path.join(FONT_DIR, fname + ".ttf")
        offset, encoding = charmap(path)
        for ch in ALPHABET:
            img = render(path, [ch], SIZE, offset, encoding)
            name = f"{n:04d}.raw"
            open(os.path.join(OUT_DIR, name), "wb").write(img.tobytes())
            index.append({
                "file": name, "w": img.width, "h": img.height,
                "font": fname, "level": "isoliert", "size": SIZE, "text": ch,
            })
            n += 1
        img = render(path, [ALPHABET], SIZE, offset, encoding)
        name = f"{n:04d}.raw"
        open(os.path.join(OUT_DIR, name), "wb").write(img.tobytes())
        index.append({
            "file": name, "w": img.width, "h": img.height,
            "font": fname, "level": "alphabet", "size": SIZE, "text": ALPHABET,
        })
        n += 1

    with open(os.path.join(OUT_DIR, "index.json"), "w", encoding="utf-8") as fh:
        json.dump(index, fh, ensure_ascii=False, indent=1)
    print(f"{n} Bilder -> {OUT_DIR}  ({len(FONTS)} Fonts x 26 isoliert + 1 Alphabetzeile)")


if __name__ == "__main__":
    main()

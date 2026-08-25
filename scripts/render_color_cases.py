"""Rendert dieselben Runenzeilen in verschiedenen Tinte/Papier-Farben."""

from __future__ import annotations

import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
from gen_atlas import charmap  # noqa: E402

OUT = ROOT / "ml" / "checkpoints" / "color-cases"
FONTS = ["Phoenix-Gobsch", "Phoenix-Taluz", "Phoenix-Xersesch"]
LINES = [
    "AN DER KUESTE LAG EIN KLEINER HAFEN",
    "IN DEM FISCHER JEDEN MORGEN IHRE BOOTE",
    "ZU WASSER LIESSEN DIE LUFT ROCH NACH SALZ",
]
TRUTH = " ".join(LINES)

# Typische LARP-Faelle plus Kontrast-Extrema. RGB 0..255.
CASES = [
    ("schwarz-weiss", (255, 255, 255), (0, 0, 0), "Baseline"),
    ("weiss-schwarz", (0, 0, 0), (255, 255, 255), "Negativ / dunkles Papier"),
    ("navy-weiss", (255, 255, 255), (20, 40, 110), "Dunkelblau auf Hell"),
    ("rot-weiss", (255, 255, 255), (160, 20, 20), "Dunkelrot auf Hell"),
    ("gruen-weiss", (255, 255, 255), (20, 110, 40), "Dunkelgruen auf Hell"),
    ("gelb-weiss", (255, 255, 255), (230, 210, 40), "Gelb auf Weiss, wenig Kontrast"),
    ("gold-weiss", (255, 255, 255), (196, 150, 40), "Gold auf Weiss"),
    ("hellgrau-weiss", (255, 255, 255), (190, 190, 190), "Hellgrau auf Weiss"),
    ("schwarz-pergament", (236, 220, 180), (30, 22, 12), "Pergament"),
    ("schwarz-braun", (120, 80, 45), (20, 10, 5), "Braun auf Braun"),
    ("weiss-navy", (18, 28, 80), (240, 240, 255), "Weiss auf Dunkelblau"),
    ("gelb-schwarz", (0, 0, 0), (240, 210, 40), "Gelb auf Schwarz"),
    ("weiss-dunkelgrau", (40, 40, 40), (245, 245, 245), "Weiss auf Grau"),
    ("schwarz-mittelgrau", (128, 128, 128), (0, 0, 0), "Schwarz auf Mittelgrau"),
    ("weiss-mittelgrau", (128, 128, 128), (255, 255, 255), "Weiss auf Mittelgrau"),
]


def lum(rgb: tuple[int, int, int]) -> int:
    r, g, b = rgb
    return (r * 77 + g * 150 + b * 29) >> 8


def render(font_name: str, paper: tuple[int, int, int], ink: tuple[int, int, int], margin=False):
    path = ROOT / f"{font_name}.ttf"
    offset, encoding = charmap(str(path))
    size = 36
    font = ImageFont.truetype(str(path), size, encoding=encoding)
    enc = lambda s: "".join(chr(offset + ord(c)) for c in s)
    encoded = [enc(line) for line in LINES]
    pad = 28
    width = int(max(font.getlength(line) for line in encoded)) + 2 * pad
    pitch = int(size * 1.85)
    height = pitch * len(LINES) + 2 * pad
    img = Image.new("RGB", (width, height), paper)
    draw = ImageDraw.Draw(img)
    for i, line in enumerate(encoded):
        draw.text((pad, pad + size + i * pitch), line, font=font, fill=ink, anchor="ls")
    if margin:
        framed = Image.new("RGB", (width + 160, height + 160), (8, 8, 8))
        framed.paste(img, (80, 80))
        return framed
    return img


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    index = []
    for font in FONTS:
        for name, paper, ink, note in CASES:
            img = render(font, paper, ink)
            file = f"{font.replace('Phoenix-', '')}_{name}.jpg"
            img.save(OUT / file, quality=92)
            index.append({
                "file": file,
                "font": font,
                "case": name,
                "note": note,
                "paper": list(paper),
                "ink": list(ink),
                "paperLum": lum(paper),
                "inkLum": lum(ink),
                "delta": abs(lum(paper) - lum(ink)),
                "truth": TRUTH,
            })
        img = render(font, (255, 255, 255), (0, 0, 0), margin=True)
        file = f"{font.replace('Phoenix-', '')}_tischrand.jpg"
        img.save(OUT / file, quality=92)
        index.append({
            "file": file,
            "font": font,
            "case": "tischrand",
            "note": "Schwarzer Tisch um weissen Brief",
            "paper": [255, 255, 255],
            "ink": [0, 0, 0],
            "paperLum": lum((255, 255, 255)),
            "inkLum": lum((0, 0, 0)),
            "delta": 255,
            "truth": TRUTH,
        })
    (OUT / "index.json").write_text(json.dumps(index, indent=2), encoding="utf-8")
    print(f"{len(index)} Bilder in {OUT}")


if __name__ == "__main__":
    main()

"""Vorverarbeitung auf die echten Fotos loslassen und das Ergebnis ablegen."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import cv2
import numpy as np

from runenscanner import preprocess

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "build"
OUT.mkdir(exist_ok=True)

for src in sorted((ROOT / "img").glob("*.jpg")):
    page = preprocess.load(src)
    h, w = page.shape
    coverage = page.ink.mean()
    found = "ja " if page.quad is not None else "nein"
    print(f"{src.name:32s} Seite gefunden: {found}  entzerrt {w}x{h}  Tinte {coverage:6.2%}")

    name = src.stem.replace(" ", "_")
    cv2.imwrite(str(OUT / f"prep_{name}.png"), page.as_image())

print(f"\ngeschrieben nach {OUT}")

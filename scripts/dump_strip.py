"""Den normierten Zeilenstreifen ausgeben, so wie der Abgleich ihn sieht.

Daneben dieselbe Zeile aus der Schrift gesetzt. Was sich zwischen beiden
unterscheidet, ist genau das, woran die Erkennung scheitert.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import cv2
import numpy as np

from runenscanner import discover, preprocess
from runenscanner.match import WORK_EM, TemplateBank
from runenscanner.render import render_text
from runenscanner.segment import find_lines, straighten

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "build"

TEXT = "franz jagt im komplett verwahrlosten taxi quer durch bayern"


def normalised(line, bank) -> np.ndarray:
    flat = straighten(line.ink)
    h, w = flat.shape
    raw_em = h / max(bank.line_extent, 0.1)
    norm = WORK_EM / raw_em
    strip = cv2.resize(flat.astype(np.float32),
                       (max(int(round(w * norm)), 1), max(int(round(h * norm)), 1)),
                       interpolation=cv2.INTER_AREA)
    return (strip > 0.35).astype(np.uint8) * 255


fonts = discover(ROOT / "fonts")
bank = TemplateBank(fonts["Runen"])
print(f"line_extent = {bank.line_extent:.3f} em")

clean = np.asarray(render_text(fonts["Runen"], TEXT, em=96)) < 128
clean_line = find_lines(clean)[0]
clean_strip = normalised(clean_line, bank)
print(f"sauber : Zeile {clean_line.height}px hoch -> normiert {clean_strip.shape}")

page = preprocess.load(ROOT / "img" / "ABC test bild gerade.jpg")
photo_line = find_lines(page.ink)[1]
photo_strip = normalised(photo_line, bank)
print(f"foto   : Zeile {photo_line.height}px hoch -> normiert {photo_strip.shape}")

# Beide Streifen untereinander, auf gleiche Breite gebracht.
width = max(clean_strip.shape[1], photo_strip.shape[1])
def pad(a):
    return np.pad(a, ((0, 0), (0, width - a.shape[1])), constant_values=255)

gap = np.full((16, width), 255, np.uint8)
cv2.imwrite(str(OUT / "strip_vergleich.png"),
            np.vstack([pad(clean_strip), gap, pad(photo_strip)]))

# Und ein Ausschnitt vom Anfang, gross genug zum Hinsehen.
crop = 900
detail = np.vstack([pad(clean_strip)[:, :crop], gap[:, :crop], pad(photo_strip)[:, :crop]])
cv2.imwrite(str(OUT / "strip_detail.png"),
            cv2.resize(detail, None, fx=2, fy=2, interpolation=cv2.INTER_NEAREST))
print("geschrieben: build/strip_vergleich.png, build/strip_detail.png")

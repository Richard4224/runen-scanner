"""Die Erkennung messen -- erst auf sauberem Satz, dann auf den echten Fotos.

Erst sauber, dann schmutzig: schlaegt schon der sauber gesetzte Text fehl,
liegt es am Abgleich und nicht am Foto.
"""

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import cv2
import numpy as np

from runenscanner import discover, preprocess
from runenscanner.match import TemplateBank, calibrate_aspect, read_line
from runenscanner.render import render_text
from runenscanner.segment import find_lines, render_overlay

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "build"
OUT.mkdir(exist_ok=True)

TRUTH = [
    "a b c d e f g h i j k l m n o p q r s t u v w x y z",
    "franz jagt im komplett verwahrlosten taxi quer durch bayern",
    "der junge ruft froh jeden morgen bevor er ruhig fort ging",
    "es ist so und er hat es nie zu tun",
]


def similarity(a: str, b: str) -> float:
    """1.0 = gleich. Normierte Levenshtein-Aehnlichkeit."""
    a, b = a.strip(), b.strip()
    if not a and not b:
        return 1.0
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return 1.0 - prev[-1] / max(len(a), len(b), 1)


def report(label: str, ink: np.ndarray, bank: TemplateBank, truth: list[str]) -> None:
    print(f"\n=== {label} ===")
    t0 = time.time()
    lines = find_lines(ink)
    aspect = calibrate_aspect(lines, bank)
    print(f"{len(lines)} Zeilen gefunden, erwartet {len(truth)}; "
          f"Seitenverhaeltnis {aspect:.2f}")

    total = 0.0
    for i, line in enumerate(lines):
        reading = read_line(line, bank, aspect=aspect)
        expect = truth[i] if i < len(truth) else ""
        sim = similarity(reading.text, expect)
        total += sim
        print(f"  Zeile {i + 1}  {sim:6.1%}  guete {reading.score:.2f}")
        print(f"    soll: {expect}")
        print(f"    ist : {reading.text.strip()}")

    if lines:
        print(f"  Mittel: {total / len(lines):.1%}   ({time.time() - t0:.1f}s)")


fonts = discover(ROOT / "fonts")
bank = TemplateBank(fonts["Runen"])

# 1. Sauber gesetzt -- der Grundtest.
clean = render_text(fonts["Runen"], "\n".join(TRUTH), em=96)
clean_ink = np.asarray(clean) < 128
cv2.imwrite(str(OUT / "clean_lines.png"), render_overlay(clean_ink, find_lines(clean_ink)))
report("sauber gesetzt", clean_ink, bank, TRUTH)

# 2. Die echten Fotos. Ueber den Ordner laufen statt Namen aufzuzaehlen --
# an Umlauten in Dateinamen sind hier schon Aufrufe gescheitert.
for src in sorted((ROOT / "img").glob("ABC*.jpg")):
    page = preprocess.load(src)
    lines = find_lines(page.ink)
    cv2.imwrite(str(OUT / f"lines_{src.stem.replace(' ', '_')}.png"),
                render_overlay(page.ink, lines))
    report(src.name, page.ink, bank, TRUTH)

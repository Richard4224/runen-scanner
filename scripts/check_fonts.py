"""Alle Schriften einlesen und je ein Uebersichtsblatt nach build/ schreiben.

Damit laesst sich pruefen, ob die gerenderten Referenzglyphen zu den
Phoenix-TTFs in fonts/ passen.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from runenscanner import discover
from runenscanner.render import contact_sheet, render_text

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "build"
OUT.mkdir(exist_ok=True)

fonts = discover(ROOT / "fonts")
for key, font in fonts.items():
    letters = font.alphabet()
    missing = [c for c in "abcdefghijklmnopqrstuvwxyz" if font.glyph(c) is None or font.glyph(c).empty]
    print(f"{key:14s} upem={font.upem:5d} "
          f"{'symbol ' if font.symbol_encoded else 'unicode'} "
          f"sichtbar={len(letters):2d} "
          f"space={font.space_advance():.3f}em "
          f"breite={min(g.advance for g in letters):.2f}-{max(g.advance for g in letters):.2f}em"
          + (f"  FEHLT: {''.join(missing)}" if missing else ""))
    contact_sheet(font).save(OUT / f"abc_{key}.png")

sample = fonts["Runen"]
render_text(sample, "franz jagt im komplett\nverwahrlosten taxi quer durch bayern").save(
    OUT / "sauber_runen.png"
)
print(f"\ngeschrieben nach {OUT}")

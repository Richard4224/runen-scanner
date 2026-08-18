"""Zugriff auf die Phoenix-Runenschriften.

Die acht TTFs sind reine Chiffre-Schriften: sie bilden lateinische Buchstaben auf
Runen-Glyphen ab. Zwei Kodierungen kommen vor:

  * Unicode-cmap  -- 'a' liegt auf U+0061  (Phoenix-Runen, Phoenix-Lacrimat)
  * Symbol-cmap   -- 'a' liegt auf U+F061  (die uebrigen sechs)

`RuneFont` verbirgt diesen Unterschied: nach aussen spricht man immer in
lateinischen Buchstaben.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from fontTools.ttLib import TTFont

ALPHABET = "abcdefghijklmnopqrstuvwxyz"

#: Zeichen, die in den Schriften zwar kodiert sind, aber eine leere Zeichnung
#: haben -- sie belegen Platz, sind aber unsichtbar. Wer Briefe setzt, sollte
#: sie meiden (ae/oe/ue/ss schreiben, Zahlen ausschreiben).
INVISIBLE_HINT = "0123456789.,!?äöüßÄÖÜ"


@dataclass(frozen=True)
class Glyph:
    """Ein Buchstabe in einer Runenschrift."""

    char: str
    name: str
    advance: float  # in em
    empty: bool     # True, wenn die Zeichnung leer ist (unsichtbar)


class RuneFont:
    def __init__(self, path: str | Path):
        self.path = Path(path)
        self._tt = TTFont(str(self.path), fontNumber=0, lazy=True)
        self.upem: int = self._tt["head"].unitsPerEm
        self._cmap: dict[int, str] = self._best_cmap()
        self.symbol_encoded: bool = 0xF041 in self._cmap and 0x41 not in self._cmap

    # -- interna ---------------------------------------------------------

    def _best_cmap(self) -> dict[int, str]:
        """Bevorzugt die Unicode-Tabelle, faellt auf die Symbol-Tabelle zurueck."""
        tables = self._tt["cmap"].tables
        unicode_map: dict[int, str] = {}
        symbol_map: dict[int, str] = {}
        for t in tables:
            target = symbol_map if (t.platformID, t.platEncID) == (3, 0) else unicode_map
            target.update(t.cmap)
        return unicode_map or symbol_map

    def codepoint(self, char: str) -> int:
        """Der Codepoint, unter dem `char` in dieser Schrift tatsaechlich liegt."""
        cp = ord(char)
        if self.symbol_encoded:
            if cp in self._cmap:
                return cp
            return 0xF000 + cp
        return cp

    # -- oeffentlich -----------------------------------------------------

    @property
    def name(self) -> str:
        return self.path.stem

    def encode(self, text: str) -> str:
        """Klartext -> die Zeichenkette, die in dieser Schrift gesetzt werden muss."""
        return "".join(chr(self.codepoint(c)) for c in text)

    def has(self, char: str) -> bool:
        return self.codepoint(char) in self._cmap

    def glyph(self, char: str) -> Glyph | None:
        cp = self.codepoint(char)
        name = self._cmap.get(cp)
        if name is None:
            return None
        advance = self._tt["hmtx"][name][0] / self.upem
        glyf = self._tt["glyf"]
        empty = glyf[name].numberOfContours == 0
        return Glyph(char=char, name=name, advance=advance, empty=empty)

    def alphabet(self) -> list[Glyph]:
        """Die 26 Buchstaben, in alphabetischer Reihenfolge."""
        out = []
        for c in ALPHABET:
            g = self.glyph(c)
            if g is not None and not g.empty:
                out.append(g)
        return out

    def space_advance(self) -> float:
        g = self.glyph(" ")
        return g.advance if g else 0.25

    def __repr__(self) -> str:
        enc = "symbol" if self.symbol_encoded else "unicode"
        return f"<RuneFont {self.name} upem={self.upem} {enc} letters={len(self.alphabet())}>"


def discover(directory: str | Path) -> dict[str, RuneFont]:
    """Alle Phoenix-Schriften in `directory`, nach Kurznamen ('Runen', 'Taluz')."""
    fonts: dict[str, RuneFont] = {}
    for p in sorted(Path(directory).glob("*.ttf")):
        f = RuneFont(p)
        key = f.name.removeprefix("Phoenix-")
        fonts[key] = f
    return fonts

"""Textzeilen in einer entzerrten Seite finden.

Bewusst nur Zeilen, keine einzelnen Zeichen: die Runen greifen ineinander und
ihre Sternchen haengen nicht am Hauptstrich, deshalb laesst sich ein Zeichen
nicht an zusammenhaengender Flaeche erkennen. Wo ein Buchstabe aufhoert,
entscheidet spaeter der Abgleich mit den Referenzglyphen.
"""

from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np


@dataclass
class Line:
    """Ein waagerechter Streifen der Seite, der eine Textzeile enthaelt."""

    top: int
    bottom: int
    left: int
    right: int
    ink: np.ndarray  # der ausgeschnittene Streifen, bool

    @property
    def height(self) -> int:
        return self.bottom - self.top

    @property
    def width(self) -> int:
        return self.right - self.left

    def __repr__(self) -> str:
        return f"<Line y={self.top}..{self.bottom} x={self.left}..{self.right}>"


def _row_profile(ink: np.ndarray, smooth: int) -> np.ndarray:
    """Tinte pro Bildzeile, geglaettet."""
    profile = ink.sum(axis=1).astype(np.float32)
    if smooth > 1:
        kernel = np.ones(smooth, dtype=np.float32) / smooth
        profile = np.convolve(profile, kernel, mode="same")
    return profile


def _runs(mask: np.ndarray) -> list[tuple[int, int]]:
    """Zusammenhaengende True-Bereiche als (start, ende)."""
    padded = np.concatenate(([False], mask, [False]))
    edges = np.flatnonzero(padded[1:] != padded[:-1])
    return list(zip(edges[0::2], edges[1::2]))


def find_lines(
    ink: np.ndarray,
    min_height: int = 12,
    min_ink_fraction: float = 0.04,
) -> list[Line]:
    """Textzeilen ueber das waagerechte Tintenprofil finden.

    `min_ink_fraction` misst gegen die staerkste Zeile der Seite -- so bleibt
    das Verfahren unabhaengig davon, wie gross der Text fotografiert wurde.
    """
    height, width = ink.shape
    profile = _row_profile(ink, smooth=max(3, height // 400))
    peak = profile.max()
    if peak <= 0:
        return []

    bands = _runs(profile > peak * min_ink_fraction)

    lines: list[Line] = []
    for top, bottom in bands:
        if bottom - top < min_height:
            continue
        offset = _tighten(ink[top:bottom])
        if offset is None:
            continue
        lo, hi = offset
        top, bottom = top + lo, top + hi

        strip = ink[top:bottom]
        cols = np.flatnonzero(strip.sum(axis=0) > 0)
        if cols.size == 0:
            continue
        left, right = int(cols[0]), int(cols[-1]) + 1
        if right - left < min_height:
            continue
        lines.append(Line(top=top, bottom=bottom, left=left, right=right,
                          ink=strip[:, left:right]))

    return _drop_outliers(lines)


def _tighten(band: np.ndarray, floor: float = 0.05) -> tuple[int, int] | None:
    """Das Band auf die Zeile selbst zusammenziehen.

    Aus der Bandhoehe wird spaeter die Schriftgroesse berechnet, und daraus
    wiederum jeder Zeichenvorschub. Zaehlen ein paar Rauschzeilen ueber oder
    unter dem Text mit, faellt die Zeile zu hoch aus, der Streifen wird beim
    Normieren zu schmal gestaucht -- und dann passt keine Glyphe mehr.

    Genommen wird deshalb nur der zusammenhaengende Bereich um die tintenreichste
    Bildzeile herum. Losgeloeste Flecken daneben fallen weg, duenne Oberlaengen
    bleiben erhalten, weil sie mit dem Zeichenkoerper verbunden sind.
    """
    profile = band.sum(axis=1).astype(np.float32)
    peak = profile.max()
    if peak <= 0:
        return None

    dense = profile > peak * floor
    core = int(np.argmax(profile))

    lo = core
    while lo > 0 and dense[lo - 1]:
        lo -= 1
    hi = core + 1
    while hi < len(profile) and dense[hi]:
        hi += 1

    return (lo, hi) if hi > lo else None


def _drop_outliers(lines: list[Line]) -> list[Line]:
    """Streifen verwerfen, die deutlich niedriger sind als der Rest.

    Faengt Reste von Menueleisten, Bildkanten und Rauschbaendern ab, ohne eine
    echte Textzeile zu opfern -- Zeilen derselben Schrift sind aehnlich hoch.
    """
    if len(lines) < 3:
        return lines
    heights = np.array([ln.height for ln in lines], dtype=np.float32)
    typical = float(np.median(heights))
    return [ln for ln in lines if ln.height >= 0.45 * typical]


def estimate_em(line: Line) -> float:
    """Schriftgroesse der Zeile schaetzen, in Pixeln pro em.

    Die Runen fuellen ungefaehr zwei Drittel der em-Hoehe -- der Streifen
    umfasst Ober- und Unterlaengen, also ist die Streifenhoehe eine brauchbare
    erste Naeherung. Verfeinert wird spaeter ueber die Trefferguete.
    """
    return line.height / 0.75


def straighten(strip: np.ndarray) -> np.ndarray:
    """Die Grundlinie einer Zeile waagerecht ziehen.

    Der Abgleich haelt die Grundlinie ueber die ganze Zeile fest -- also muss
    sie hier gerade werden. Eine blosse Drehung reicht dafuer nicht: bei einem
    schraeg gehaltenen Handy laeuft die Zeile nicht nur schief, sie verjuengt
    sich auch zum Rand hin, und die Restverzerrung ist gekruemmt.

    Deshalb wird die Grundlinie tatsaechlich gemessen: je Bildspalte der
    Schwerpunkt der Tinte, stark geglaettet, damit Ober- und Unterlaengen
    einzelner Zeichen sich herausmitteln. Anschliessend wird jede Spalte um
    ihre Abweichung nach oben oder unten geschoben. Das gleicht Drehung,
    Verjuengung und Woelbung in einem Schritt aus.
    """
    ink = strip.astype(np.float32)
    height, width = ink.shape
    if width < 8 or height < 4:
        return strip

    weight = ink.sum(axis=0)
    rows = np.arange(height, dtype=np.float32)
    centroid = (ink * rows[:, None]).sum(axis=0) / np.maximum(weight, 1e-6)

    if not np.any(weight > 0):
        return strip
    solid = weight > 0.2 * np.median(weight[weight > 0])
    if solid.sum() < 16:
        return strip

    # Bewusst eine Parabel und nichts Flexibleres. Eine Kurve, die sich der
    # gemessenen Schwerpunktlinie eng anschmiegt, gleicht nicht die Verzerrung
    # aus, sondern verbiegt die Zeichen selbst -- der Schwerpunkt schwankt ja
    # von Buchstabe zu Buchstabe. Zwei Freiheitsgrade koennen genau das, was
    # wirklich vorkommt: Schraeglage und sanfte Woelbung.
    x = np.arange(width, dtype=np.float64)
    coeffs = np.polyfit(x[solid], centroid[solid], deg=2, w=weight[solid])
    curve = np.polyval(coeffs, x)

    shift = np.rint(curve - curve.mean()).astype(np.int32)
    if np.abs(shift).max() < 2:
        return strip

    margin = int(np.abs(shift).max()) + 1
    out = np.zeros((height + 2 * margin, width), dtype=bool)
    src_rows = np.flatnonzero(strip.any(axis=0))
    for col in src_rows:
        top = margin - shift[col]
        out[top : top + height, col] = strip[:, col]

    keep = np.flatnonzero(out.any(axis=1))
    return out[keep[0] : keep[-1] + 1] if keep.size else strip


def render_overlay(ink: np.ndarray, lines: list[Line]) -> np.ndarray:
    """Zur Sichtkontrolle: gefundene Zeilen farbig umranden."""
    canvas = cv2.cvtColor(np.where(ink, 0, 255).astype(np.uint8), cv2.COLOR_GRAY2BGR)
    for ln in lines:
        cv2.rectangle(canvas, (ln.left, ln.top), (ln.right, ln.bottom), (0, 0, 255), 3)
    return canvas

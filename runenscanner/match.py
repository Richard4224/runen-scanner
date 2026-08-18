"""Runenzeile -> Buchstabenfolge.

Der Kern des Scanners. Weil die Schriften bekannt sind, wird nicht geraten,
sondern erklaert: gesucht ist die Buchstabenfolge, die -- in der echten
Schrift gesetzt -- die fotografierte Zeile am besten nachbildet.

Damit erledigen sich die zwei Probleme, an denen eine naive Zeichentrennung
scheitert. Die Zeichen sind unterschiedlich breit (0,57 bis 0,96 em bei
Phoenix-Runen), aber ihre Breiten stehen in der Schrift -- der Vorschub sagt
also, wo das naechste Zeichen beginnt. Und die Sternchen muessen nicht dem
richtigen Buchstaben zugeordnet werden, weil gar nichts zerschnitten wird.

Umgesetzt als dynamische Programmierung ueber die Zeile: fuer jede Position
die beste Erklaerung des Anfangsstuecks, Zeichen fuer Zeichen nach rechts.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import cv2
import numpy as np

from .fonts import RuneFont
from .render import Template, render_alphabet
from .segment import Line, straighten

#: Hoehe, auf die Zeilen normiert werden (Pixel pro em). Gross genug fuer die
#: Sternchen, klein genug, dass der Abgleich zuegig laeuft.
WORK_EM = 64

#: Guete, ab der ein Zeichen ueberhaupt als Erklaerung zaehlt. Darunter ist es
#: guenstiger, Leerraum anzunehmen.
SCORE_FLOOR = 0.30

#: Zulaessige Abweichung vom Soll-Vorschub, in Anteilen eines em. Faengt
#: Unterschneidung und Restverzerrung auf, die sich sonst ueber eine lange
#: Zeile aufsummieren.
ADVANCE_TOLERANCE = 0.06


@dataclass
class ScaledTemplate:
    char: str
    mask: np.ndarray        # float32, 0..1
    advance_px: int
    offset_x: int
    offset_y: int
    area: float = field(init=False)

    def __post_init__(self) -> None:
        self.area = float(self.mask.sum())


@dataclass
class Reading:
    """Das Ergebnis fuer eine Zeile."""

    text: str
    score: float            # mittlere Trefferguete je Zeichen, 0..1
    em_px: float
    #: je erkanntem Zeichen: (x im normierten Streifen, Buchstabe, Guete)
    trace: list[tuple[int, str, float]]

    @property
    def confidence(self) -> float:
        return self.score


class TemplateBank:
    """Die Referenzglyphen einer Schrift, auf eine Arbeitsgroesse gebracht."""

    def __init__(self, font: RuneFont):
        self.font = font
        self._base: dict[str, Template] = render_alphabet(font)
        self.space_advance = font.space_advance()

        from .render import TEMPLATE_EM

        # Wie hoch eine volle Zeile dieser Schrift wird, in em -- vom hoechsten
        # Ueberstand bis zur tiefsten Unterlaenge. Damit laesst sich aus der
        # gemessenen Zeilenhoehe die Schriftgroesse ausrechnen, statt sie zu
        # raten.
        tops = [t.offset_y for t in self._base.values()]
        bottoms = [t.offset_y + t.mask.shape[0] / TEMPLATE_EM for t in self._base.values()]
        self.ink_top = min(tops)
        self.ink_bottom = max(bottoms)
        self.line_extent = self.ink_bottom - self.ink_top

    def at(self, em_px: float) -> list[ScaledTemplate]:
        out: list[ScaledTemplate] = []
        for char, t in self._base.items():
            h, w = t.mask.shape
            # Die Referenz wurde bei TEMPLATE_EM gerendert; auf em_px bringen.
            scale = em_px / _template_em(t)
            nw, nh = max(int(round(w * scale)), 1), max(int(round(h * scale)), 1)
            mask = cv2.resize(t.mask, (nw, nh), interpolation=cv2.INTER_AREA)
            out.append(
                ScaledTemplate(
                    char=char,
                    mask=mask.astype(np.float32),
                    advance_px=max(int(round(t.advance * em_px)), 1),
                    offset_x=int(round(t.offset_x * em_px)),
                    offset_y=int(round(t.offset_y * em_px)),
                )
            )
        return out


def _template_em(t: Template) -> float:
    """Die em-Groesse, bei der `t` gerendert wurde."""
    from .render import TEMPLATE_EM

    return float(TEMPLATE_EM)


def _dice_maps(strip: np.ndarray, templates: list[ScaledTemplate]) -> dict[str, np.ndarray]:
    """Fuer jede Glyphe: wie gut passt sie an jeder Stelle der Zeile?

    Gemessen wird mit dem Dice-Koeffizienten -- doppelte Ueberlappung geteilt
    durch die Summe beider Flaechen. Der Wert liegt zwischen 0 und 1 und ist
    unempfindlich dagegen, wie gross die Glyphe ist; ein kleines Zeichen
    gewinnt also nicht automatisch gegen ein grosses.
    """
    img = strip.astype(np.float32)
    maps: dict[str, np.ndarray] = {}

    for t in templates:
        th, tw = t.mask.shape
        if th > img.shape[0] or tw > img.shape[1]:
            maps[t.char] = np.zeros((1, 1), dtype=np.float32)
            continue

        overlap = cv2.matchTemplate(img, t.mask, cv2.TM_CCORR)
        local_ink = cv2.matchTemplate(img, np.ones_like(t.mask), cv2.TM_CCORR)
        maps[t.char] = (2.0 * overlap) / np.maximum(local_ink + t.area, 1e-6)

    return maps


def _score_rows(
    maps: dict[str, np.ndarray],
    templates: list[ScaledTemplate],
    baseline: int,
    width: int,
) -> dict[str, np.ndarray]:
    """Fuer eine feste Grundlinie: je Glyphe die Guete entlang der Zeile.

    Die Grundlinie fest zu waehlen ist der entscheidende Punkt. Darf jede
    Glyphe ihre Hoehe frei suchen, findet irgendein Zeichen ueberall
    irgendeinen guten Fleck, und die Zeile zerfaellt in Unsinn. Alle Zeichen
    einer Zeile stehen aber auf derselben Linie.
    """
    rows: dict[str, np.ndarray] = {}
    for t in templates:
        dmap = maps[t.char]
        row_index = baseline + t.offset_y
        row = np.zeros(width, dtype=np.float32)
        if 0 <= row_index < dmap.shape[0]:
            src = dmap[row_index]
            # Glyphe beginnt bei x + offset_x; auf den Ursprung zurueckrechnen.
            lo = max(0, -t.offset_x)
            hi = min(width, src.shape[0] - t.offset_x)
            if hi > lo:
                row[lo:hi] = src[lo + t.offset_x : hi + t.offset_x]
        rows[t.char] = row
    return rows


def decode_strip(
    strip: np.ndarray,
    bank: TemplateBank,
    em_px: float,
    baseline: int,
    templates: list[ScaledTemplate] | None = None,
    maps: dict[str, np.ndarray] | None = None,
) -> Reading:
    """Eine auf `em_px` normierte Zeile in Buchstaben aufloesen.

    `templates` und `maps` koennen vorberechnet hereingereicht werden -- sie
    haengen nur an der Groesse, nicht an der Grundlinie, und sind der teure
    Teil der Rechnung.
    """
    if templates is None:
        templates = bank.at(em_px)
    if maps is None:
        maps = _dice_maps(strip, templates)

    width = strip.shape[1]
    rows = _score_rows(maps, templates, baseline, width)

    col_ink = strip.sum(axis=0).astype(np.float32)
    prefix = np.concatenate(([0.0], np.cumsum(col_ink)))
    height = max(strip.shape[0], 1)

    space_px = max(int(round(bank.space_advance * em_px)), 1)
    tol = max(int(round(ADVANCE_TOLERANCE * em_px)), 1)

    NEG = -1e9
    best = np.full(width + 1, NEG, dtype=np.float64)
    best[0] = 0.0
    # Rueckverfolgung: (vorherige Position, Buchstabe, Guete)
    back: list[tuple[int, str, float] | None] = [None] * (width + 1)

    for x in range(width):
        if best[x] == NEG:
            continue
        base = best[x]

        # Leerraum: lohnt sich, wo tatsaechlich kaum Tinte steht.
        for adv in (space_px, space_px + tol):
            nx = x + adv
            if nx > width:
                continue
            density = (prefix[nx] - prefix[x]) / (adv * height)
            gain = adv * (0.55 - 6.0 * density - SCORE_FLOOR)
            if base + gain > best[nx]:
                best[nx] = base + gain
                back[nx] = (x, " ", 0.0)

        for t in templates:
            score = float(rows[t.char][x])
            if score < SCORE_FLOOR:
                continue
            for adv in (t.advance_px - tol, t.advance_px, t.advance_px + tol):
                nx = x + adv
                if adv <= 0 or nx > width:
                    continue
                # Nach Vorschub gewichten, sonst gewinnen immer die schmalsten
                # Zeichen: viele schmale Treffer summieren sich sonst hoeher als
                # wenige breite, ganz gleich wie gut sie passen.
                gain = adv * (score - SCORE_FLOOR)
                if base + gain > best[nx]:
                    best[nx] = base + gain
                    back[nx] = (x, t.char, score)

    # Das Ende der Zeile muss nicht exakt getroffen werden -- die beste
    # Erklaerung im letzten Stueck zaehlt.
    tail = max(range(max(width - 2 * space_px, 0), width + 1), key=lambda i: best[i])

    trace: list[tuple[int, str, float]] = []
    x = tail
    while x > 0 and back[x] is not None:
        prev, char, score = back[x]
        trace.append((prev, char, score))
        x = prev
    trace.reverse()

    text = "".join(c for _, c, _ in trace)
    letters = [s for _, c, s in trace if c != " "]
    mean = float(np.mean(letters)) if letters else 0.0
    return Reading(text=text, score=mean, em_px=em_px, trace=trace)


#: Seitenverhaeltnisse, die beim Einmessen einer Seite durchprobiert werden.
#: Deckt ab, was ein schraeg gehaltenes Handy an Stauchung erzeugt.
ASPECTS = (0.80, 0.90, 1.00, 1.12, 1.25, 1.40, 1.55, 1.72, 1.90)


def read_line(
    line: Line,
    bank: TemplateBank,
    aspect: float = 1.0,
    scales: tuple[float, ...] = (0.95, 1.02, 1.10, 1.18, 1.27, 1.36),
) -> Reading:
    """Eine Zeile lesen; Schriftgroesse und Grundlinie werden mitbestimmt.

    Die Schaetzung aus der Zeilenhoehe ist grob -- Ober- und Unterlaengen
    haengen davon ab, welche Buchstaben zufaellig vorkommen. Deshalb werden
    mehrere Groessen und Grundlinien durchprobiert und die Kombination
    genommen, die die Zeile am besten erklaert.
    """
    # Zeilenhoehe geteilt durch die Hoehe, die eine volle Zeile dieser Schrift
    # einnimmt. Enthaelt die Zeile nicht gerade die hoechste und die tiefste
    # Glyphe, faellt die Schaetzung etwas zu klein aus -- das faengt die
    # Groessensuche weiter unten ab.
    flat = straighten(line.ink)
    height, width = flat.shape

    raw_em = height / max(bank.line_extent, 0.1)
    norm = WORK_EM / raw_em
    # Waagerecht getrennt skalieren: beim Entzerren eines Trapezes laesst sich
    # das echte Seitenverhaeltnis nicht zurueckrechnen, der Text kann also
    # gestaucht ankommen. `aspect` gleicht das aus.
    strip = cv2.resize(
        flat.astype(np.float32),
        (max(int(round(width * norm * aspect)), 1), max(int(round(height * norm)), 1)),
        interpolation=cv2.INTER_AREA,
    )
    strip = (strip > 0.35).astype(np.float32)

    # Etwas Luft oben und unten, damit Glyphen mit Ueberhang noch passen.
    pad = WORK_EM // 3
    strip = np.pad(strip, ((pad, pad), (0, 0)))

    best: Reading | None = None
    for s in scales:
        em_px = WORK_EM * s
        templates = bank.at(em_px)
        maps = _dice_maps(strip, templates)

        # Die oberste Tinte der Zeile gehoert zur hoechsten vorkommenden
        # Glyphe. Deren Ueberstand kennen wir -- daraus folgt die Grundlinie.
        highest = min(t.offset_y for t in templates)
        centre = pad - highest
        span = max(int(round(0.18 * em_px)), 3)

        for dy in range(centre - span, centre + span + 1, 2):
            reading = decode_strip(strip, bank, em_px, dy, templates, maps)
            if best is None or reading.score > best.score:
                best = reading

    assert best is not None
    return best


def calibrate_aspect(lines: list[Line], bank: TemplateBank) -> float:
    """Das Seitenverhaeltnis der Seite an ihrer laengsten Zeile einmessen.

    Die Stauchung stammt aus der Kamerahaltung und gilt fuer die ganze Seite,
    muss also nur einmal bestimmt werden -- an der Zeile mit dem meisten Text,
    weil dort ein falscher Wert am deutlichsten auffaellt.
    """
    if not lines:
        return 1.0
    probe = max(lines, key=lambda ln: int(ln.ink.sum()))

    best_aspect, best_score = 1.0, -1.0
    for aspect in ASPECTS:
        reading = read_line(probe, bank, aspect=aspect, scales=(1.0, 1.12))
        if reading.score > best_score:
            best_aspect, best_score = aspect, reading.score
    return best_aspect


def read_page(ink: np.ndarray, bank: TemplateBank) -> list[Reading]:
    from .segment import find_lines

    lines = find_lines(ink)
    aspect = calibrate_aspect(lines, bank)
    return [read_line(ln, bank, aspect=aspect) for ln in lines]

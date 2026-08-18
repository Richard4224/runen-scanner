"""Vom Foto zur sauberen Schwarz-Weiss-Vorlage.

Ein abfotografierter Brief bringt vier Stoerungen mit, die nacheinander weg
muessen:

  1. Umgebung   -- Bildschirmrahmen, Menueleisten, Tischplatte
  2. Perspektive -- schraeg gehaltene Kamera verzieht die Zeilen
  3. Beleuchtung -- eine Bildhaelfte heller als die andere
  4. Rauschen    -- Moire beim Abfotografieren von Bildschirmen, Papierkorn

Wichtig: die kleinen Sternchen und Punkte gehoeren zu den Buchstaben. Sie
duerfen beim Entrauschen nicht mit verschwinden -- an ihnen haengt der
Unterschied zwischen f, j, o, r und y.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np


@dataclass
class Page:
    """Eine entzerrte, binarisierte Seite. `ink` ist True, wo Schrift ist."""

    ink: np.ndarray      # bool
    gray: np.ndarray     # uint8, entzerrt aber ungeschwellt
    quad: np.ndarray | None  # die vier Eckpunkte im Originalbild, falls gefunden
    angle: float = 0.0   # Winkel, um den zum Geraderuecken gedreht wurde

    @property
    def shape(self) -> tuple[int, int]:
        return self.ink.shape

    def as_image(self) -> np.ndarray:
        """Schwarze Schrift auf weiss -- zum Anschauen."""
        return np.where(self.ink, 0, 255).astype(np.uint8)


def _downscale(img: np.ndarray, max_side: int) -> tuple[np.ndarray, float]:
    h, w = img.shape[:2]
    scale = min(max_side / max(h, w), 1.0)
    if scale >= 1.0:
        return img, 1.0
    return cv2.resize(img, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA), scale


def find_page_quad(gray: np.ndarray) -> np.ndarray | None:
    """Das helle Viereck der Schreibflaeche suchen (Papier bzw. Bildschirm).

    Arbeitet auf einer verkleinerten Kopie: die Kante interessiert grob, nicht
    pixelgenau, und klein ist es robuster gegen Moire.
    """
    small, scale = _downscale(gray, 900)
    blur = cv2.GaussianBlur(small, (7, 7), 0)

    # Otsu trennt die helle Flaeche vom dunklen Drumherum.
    _, mask = cv2.threshold(blur, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((15, 15), np.uint8))
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((9, 9), np.uint8))

    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None

    page_area = small.shape[0] * small.shape[1]
    best = max(contours, key=cv2.contourArea)
    if cv2.contourArea(best) < 0.15 * page_area:
        return None

    peri = cv2.arcLength(best, True)
    approx = cv2.approxPolyDP(best, 0.02 * peri, True)
    if len(approx) != 4:
        # Kein sauberes Viereck -- das umschliessende gedrehte Rechteck tut es auch.
        approx = cv2.boxPoints(cv2.minAreaRect(best)).reshape(-1, 1, 2)

    return (approx.reshape(4, 2).astype(np.float32) / scale)


def order_quad(pts: np.ndarray) -> np.ndarray:
    """Ecken sortieren: oben-links, oben-rechts, unten-rechts, unten-links."""
    s = pts.sum(axis=1)
    d = np.diff(pts, axis=1).ravel()
    return np.array(
        [pts[np.argmin(s)], pts[np.argmin(d)], pts[np.argmax(s)], pts[np.argmax(d)]],
        dtype=np.float32,
    )


def warp_quad(gray: np.ndarray, quad: np.ndarray) -> np.ndarray:
    """Das Viereck perspektivisch auf ein Rechteck ziehen."""
    tl, tr, br, bl = order_quad(quad)
    width = int(max(np.linalg.norm(tr - tl), np.linalg.norm(br - bl)))
    height = int(max(np.linalg.norm(bl - tl), np.linalg.norm(br - tr)))
    width, height = max(width, 10), max(height, 10)

    dst = np.array(
        [[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]],
        dtype=np.float32,
    )
    m = cv2.getPerspectiveTransform(order_quad(quad), dst)
    return cv2.warpPerspective(gray, m, (width, height), flags=cv2.INTER_CUBIC)


def _flatten_illumination(gray: np.ndarray) -> np.ndarray:
    """Helligkeitsverlauf herausrechnen, indem durch den Hintergrund geteilt wird.

    Der Hintergrund wird per starkem Weichzeichner geschaetzt -- was uebrig
    bleibt, ist die Schrift, unabhaengig davon, wie schief die Lampe stand.
    """
    k = max(31, (min(gray.shape) // 12) | 1)
    background = cv2.GaussianBlur(gray, (k, k), 0)
    flat = gray.astype(np.float32) / np.maximum(background.astype(np.float32), 1.0)
    return np.clip(flat * 180.0, 0, 255).astype(np.uint8)


def _suppress_moire(gray: np.ndarray) -> np.ndarray:
    """Das Interferenzmuster von Bildschirmfotos daempfen.

    Ein Medianfilter buegelt das Muster weg, laesst aber Kanten stehen --
    anders als ein Weichzeichner, der die Sternchen ausfransen wuerde.
    """
    return cv2.medianBlur(gray, 5)


def _drop_specks(ink: np.ndarray, min_area: int) -> np.ndarray:
    """Einzelne Rauschpunkte entfernen, Sternchen aber behalten."""
    n, labels, stats, _ = cv2.connectedComponentsWithStats(ink.astype(np.uint8), 8)
    keep = np.zeros(n, dtype=bool)
    keep[1:] = stats[1:, cv2.CC_STAT_AREA] >= min_area
    return keep[labels]


def _drop_faint(ink: np.ndarray, flat: np.ndarray, max_mean: int) -> np.ndarray:
    """Blasse Flecken verwerfen, echte Tinte behalten.

    Die lokale Schwelle findet auch das Moire, weil sie nur auf oertlichen
    Kontrast schaut. Echte Schrift ist aber absolut dunkel, das Muster nur
    leicht grau. Also wird jeder zusammenhaengende Fleck als Ganzes bewertet:
    ist er im Mittel zu hell, fliegt er raus. Ein Sternchen bleibt dabei
    erhalten -- es ist klein, aber tiefschwarz.
    """
    n, labels, _, _ = cv2.connectedComponentsWithStats(ink.astype(np.uint8), 8)
    if n <= 1:
        return ink

    flat_sum = np.bincount(labels.ravel(), weights=flat.ravel(), minlength=n)
    sizes = np.bincount(labels.ravel(), minlength=n)
    means = flat_sum / np.maximum(sizes, 1)

    keep = means <= max_mean
    keep[0] = False
    return keep[labels]


def deskew_page(ink: np.ndarray, max_deg: float = 5.0) -> tuple[np.ndarray, float]:
    """Die ganze Seite waagerecht drehen.

    Ohne diesen Schritt scheitert schon die Zeilensuche: liegt der Text auch
    nur ein Grad schief, wandert eine Zeile ueber die Breite eines Fotos um
    mehr als ihre eigene Hoehe -- und dann ueberlappen sich im waagerechten
    Tintenprofil zwei benachbarte Zeilen zu einem einzigen Block.

    Gesucht wird der Winkel, bei dem sich die Tinte am staerksten auf wenige
    Bildzeilen buendelt. Bei gerader Schrift hat das Profil scharfe Spitzen
    mit leeren Taelern dazwischen, bei schraeger verschmiert es.
    """
    small, scale = _downscale(ink.astype(np.uint8) * 255, 1000)
    work = (small > 127).astype(np.float32)
    h, w = work.shape
    centre = (w / 2, h / 2)

    def sharpness(angle: float) -> float:
        m = cv2.getRotationMatrix2D(centre, angle, 1.0)
        rotated = cv2.warpAffine(work, m, (w, h), flags=cv2.INTER_LINEAR, borderValue=0.0)
        profile = rotated.sum(axis=1)
        return float(np.sum(profile ** 2))

    # Erst grob absuchen, dann um den Fund herum verfeinern.
    coarse = np.arange(-max_deg, max_deg + 0.01, 0.5)
    best = max(coarse, key=sharpness)
    fine = np.arange(best - 0.5, best + 0.51, 0.05)
    angle = float(max(fine, key=sharpness))

    if abs(angle) < 0.05:
        return ink, 0.0

    full_h, full_w = ink.shape
    m = cv2.getRotationMatrix2D((full_w / 2, full_h / 2), angle, 1.0)
    rotated = cv2.warpAffine(
        ink.astype(np.uint8), m, (full_w, full_h), flags=cv2.INTER_NEAREST, borderValue=0
    )
    return rotated > 0, angle


def load(path: str | Path, deskew: bool = True) -> Page:
    """Foto einlesen und in eine binarisierte Seite verwandeln."""
    raw = cv2.imdecode(np.fromfile(str(path), dtype=np.uint8), cv2.IMREAD_COLOR)
    if raw is None:
        raise ValueError(f"Bild nicht lesbar: {path}")

    gray = cv2.cvtColor(raw, cv2.COLOR_BGR2GRAY)

    quad = find_page_quad(gray) if deskew else None
    warped = warp_quad(gray, quad) if quad is not None else gray

    flat = _flatten_illumination(_suppress_moire(warped))

    # Adaptive Schwelle: entscheidet lokal, was Tinte ist. Der Block muss
    # deutlich groesser sein als ein Buchstabe, sonst frisst er die Flaechen aus.
    block = max(31, (min(flat.shape) // 25) | 1)
    binary = cv2.adaptiveThreshold(
        flat, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, block, 12
    )

    ink = binary > 0
    # Reihenfolge zaehlt: erst die blassen Flecken, dann die Kruemel. Sonst
    # zerfallen die Moire-Flecken in Einzelpunkte, die einzeln zu klein zum
    # Bewerten sind.
    ink = _drop_faint(ink, flat, max_mean=140)
    ink = _drop_specks(ink, min_area=max(6, int(0.000002 * ink.size)))

    angle = 0.0
    if deskew:
        ink, angle = deskew_page(ink)

    return Page(ink=ink, gray=warped, quad=quad, angle=angle)

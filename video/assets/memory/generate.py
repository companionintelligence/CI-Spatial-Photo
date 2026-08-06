#!/usr/bin/env python3
"""Generate the stand-in Companion memory library used by the product-video capture.

    python3 video/assets/memory/generate.py

WHAT THESE ARE
--------------
`video/capture.config.mjs` stubs `GET /api/v1/memory/media` with a fixed set of six
photos, because the From Memory grid renders the user's OWN Companion Memory library
and a capture machine has none to borrow. These JPEGs are the thumbnails behind that
stub: **synthetic stand-ins, not photographs**, in the same drawn style as
`video/assets/media/porch-1998.png` — flat gradients and silhouettes that read as a
scene at thumbnail size without pretending to be a camera original. Nothing in the
frame claims otherwise, and the PR that adds them says so.

WHY THEY ARE GENERATED AND NOT DRAWN BY HAND
--------------------------------------------
They used to be six variations of one mountain-ridge template, which was survivable
while the grid rendered untitled squares. It stopped being survivable when the grid
started rendering each item's real title (MemoryPicker.tsx): "Skyline from the roof"
and "Beach, Outer Banks" both sat over the same jagged mountains, so the caption and
the picture contradicted each other on camera. Each scene below is now composed for
the title it carries.

Committing the generator alongside the output keeps the images reproducible and keeps
their synthetic origin impossible to miss. Everything here is deterministic — a fixed
seed per scene — so re-running it produces byte-identical files and no capture drift.
"""

from __future__ import annotations

import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

SIZE = 512
OUT_DIR = Path(__file__).resolve().parent

# The tile is `aspect-square … object-cover` (MemoryPicker.tsx) and the wide capture
# renders it about 400 px across, so 512 is the smallest size with headroom.


def hexcol(value: str) -> np.ndarray:
    """Parse "#rrggbb" into a linear [0, 1] RGB triple."""
    value = value.lstrip("#")
    return np.array([int(value[i : i + 2], 16) / 255.0 for i in (0, 2, 4)], dtype=np.float64)


def canvas() -> np.ndarray:
    """A black SIZE x SIZE float image."""
    return np.zeros((SIZE, SIZE, 3), dtype=np.float64)


def yy() -> np.ndarray:
    """A column of vertical positions, 0 at the top and 1 at the bottom."""
    return np.linspace(0.0, 1.0, SIZE).reshape(-1, 1)


def vertical_gradient(top: str, bottom: str, gamma: float = 1.0) -> np.ndarray:
    """A full-frame vertical ramp between two colours."""
    t = (yy() ** gamma)[..., None]
    ramp = hexcol(top) * (1 - t) + hexcol(bottom) * t
    return np.repeat(ramp, SIZE, axis=1)


def radial_glow(
    img: np.ndarray, cx: float, cy: float, radius: float, colour: str, strength: float
) -> None:
    """Add a soft circular light, in place."""
    gx, gy = np.meshgrid(np.linspace(0, 1, SIZE), np.linspace(0, 1, SIZE))
    d = np.hypot(gx - cx, gy - cy) / radius
    falloff = np.clip(1.0 - d, 0.0, 1.0) ** 2.2
    img += hexcol(colour) * (falloff * strength)[..., None]


def mask_to_image(
    img: np.ndarray, mask: Image.Image, colour: str | np.ndarray, alpha: float = 1.0
) -> None:
    """Composite a flat colour through an 8-bit mask."""
    m = (np.asarray(mask, dtype=np.float64) / 255.0 * alpha)[..., None]
    rgb = hexcol(colour) if isinstance(colour, str) else colour
    np.copyto(img, img * (1 - m) + rgb * m)


def new_mask() -> tuple[Image.Image, ImageDraw.ImageDraw]:
    """A blank 8-bit mask and a draw handle for it."""
    m = Image.new("L", (SIZE, SIZE), 0)
    return m, ImageDraw.Draw(m)


def ridge_points(
    rng: np.random.Generator, base: float, amp: float, roughness: float, steps: int = 7
) -> list[float]:
    """Midpoint displacement, returned as one height per column (0..1, 0 = top)."""
    pts = np.array([base + rng.uniform(-amp, amp), base + rng.uniform(-amp, amp)])
    for _ in range(steps):
        mids = (pts[:-1] + pts[1:]) / 2 + rng.normal(0, amp, len(pts) - 1)
        out = np.empty(len(pts) + len(mids))
        out[0::2] = pts
        out[1::2] = mids
        pts = out
        amp *= roughness
    x = np.linspace(0, SIZE - 1, len(pts))
    return list(np.interp(np.arange(SIZE), x, pts))


def fill_ridge(draw: ImageDraw.ImageDraw, heights: list[float]) -> None:
    """Fill everything below a per-column height profile."""
    draw.polygon(
        [(x, h * SIZE) for x, h in enumerate(heights)] + [(SIZE, SIZE), (0, SIZE)],
        fill=255,
    )


def soften(mask: Image.Image, radius: float) -> Image.Image:
    """Blur a mask, or return it unchanged for radius 0."""
    return mask.filter(ImageFilter.GaussianBlur(radius)) if radius else mask


def finish(
    img: np.ndarray, rng: np.random.Generator, grain: float = 0.012, vignette: float = 0.22
) -> Image.Image:
    """Vignette, grain and a whisper of blur, then encode."""
    gx, gy = np.meshgrid(np.linspace(-1, 1, SIZE), np.linspace(-1, 1, SIZE))
    img *= 1.0 - vignette * np.clip(np.hypot(gx, gy) / 1.414, 0, 1)[..., None] ** 2.0
    img += rng.normal(0, grain, img.shape)
    out = Image.fromarray((np.clip(img, 0, 1) * 255).astype(np.uint8))
    # A whisper of blur: without it the silhouettes read as vector art rather than
    # as something photographed.
    return out.filter(ImageFilter.GaussianBlur(0.4))


# ── The six scenes ───────────────────────────────────────────────────────────────


def porch_at_sunset() -> Image.Image:
    """Low sun seen between the posts of a porch, from inside its shadow."""
    rng = np.random.default_rng(1998)
    img = vertical_gradient("#241a33", "#f0a44e", gamma=1.9)
    radial_glow(img, 0.58, 0.63, 0.55, "#ffcf7a", 0.85)

    hills, d = new_mask()
    fill_ridge(d, ridge_points(rng, 0.655, 0.02, 0.5))
    mask_to_image(img, soften(hills, 0.6), "#2a2231", 0.92)

    # The porch itself, in shadow against the sky: roof beam, two posts, a railing.
    porch, d = new_mask()
    d.rectangle([0, 0, SIZE, int(SIZE * 0.10)], fill=255)
    d.rectangle([int(SIZE * 0.05), 0, int(SIZE * 0.13), SIZE], fill=255)
    d.rectangle([int(SIZE * 0.83), 0, int(SIZE * 0.92), SIZE], fill=255)
    d.rectangle([0, int(SIZE * 0.70), SIZE, int(SIZE * 0.735)], fill=255)
    for i in range(14):
        x = int(SIZE * (0.02 + i * 0.072))
        d.rectangle([x, int(SIZE * 0.70), x + 7, int(SIZE * 0.855)], fill=255)
    d.rectangle([0, int(SIZE * 0.845), SIZE, SIZE], fill=255)
    mask_to_image(img, porch, "#140f16", 0.93)

    # Warm lamplight spilling onto the boards, so the foreground is not a dead block.
    radial_glow(img, 0.5, 1.02, 0.42, "#c9762f", 0.5)
    return finish(img, rng, grain=0.016, vignette=0.26)


def beach_outer_banks() -> Image.Image:
    """Flat sea, a breaking line and wet sand, in mid-morning light."""
    rng = np.random.default_rng(7)
    img = vertical_gradient("#9dc6dd", "#f4e3cc", gamma=2.4)

    horizon = 0.44
    # Sea, then wet sand, each faded into the next so no band has a ruled edge.
    sea = np.clip((yy() - horizon) / 0.30, 0, 1)[..., None]
    water = np.repeat(hexcol("#2b6b74") * (1 - sea) + hexcol("#86bcb2") * sea, SIZE, axis=1)
    sand = np.clip((yy() - 0.70) / 0.30, 0, 1)[..., None]
    beach = np.repeat(hexcol("#cbb99c") * (1 - sand) + hexcol("#9d8767") * sand, SIZE, axis=1)

    def blend_in(target: np.ndarray, start: float, feather: float) -> None:
        t = np.clip((yy() - start) / feather, 0, 1)[..., None]
        np.copyto(img, img * (1 - t) + target * t)

    blend_in(water, horizon, 0.012)
    blend_in(beach, 0.695, 0.05)

    # Breakers: a few soft horizontal lines, closer together towards the horizon.
    swell, d = new_mask()
    for _ in range(26):
        t = rng.random() ** 1.8
        y = (horizon + 0.02 + t * 0.23) * SIZE
        x0 = rng.uniform(-0.1, 0.75) * SIZE
        d.line(
            [x0, y, x0 + rng.uniform(0.12, 0.45) * SIZE, y],
            fill=int(40 + 130 * t),
            width=1 + int(2 * t),
        )
    mask_to_image(img, soften(swell, 1.6), "#e6f2ee", 0.5)

    # The break itself, and the thin wash it leaves on the sand.
    foam, d = new_mask()
    d.polygon(
        [(x, (0.678 + 0.010 * math.sin(x / 51.0)) * SIZE) for x in range(SIZE)]
        + [(x, (0.706 + 0.012 * math.sin(x / 37.0)) * SIZE) for x in reversed(range(SIZE))],
        fill=255,
    )
    mask_to_image(img, soften(foam, 2.6), "#f2f7f4", 0.85)

    wash, d = new_mask()
    d.polygon(
        [(x, (0.706 + 0.012 * math.sin(x / 37.0)) * SIZE) for x in range(SIZE)]
        + [(SIZE, 0.80 * SIZE), (0, 0.80 * SIZE)],
        fill=120,
    )
    mask_to_image(img, soften(wash, 9.0), "#cfd9d0", 0.45)
    return finish(img, rng, grain=0.010, vignette=0.18)


def cabin_trail_october() -> Image.Image:
    """A trail running back into autumn woods, towards the light."""
    rng = np.random.default_rng(11)
    # Light coming down the trail, so the eye has somewhere to go.
    img = vertical_gradient("#8a5a24", "#54371c", gamma=1.1)
    radial_glow(img, 0.5, 0.38, 0.60, "#f0c069", 0.85)

    # Canopy: soft blobs of autumn colour, densest at the top corners, thinning
    # towards the light in the middle.
    leaves, d = new_mask()
    for _ in range(320):
        x = rng.uniform(-0.05, 1.05)
        y = rng.uniform(-0.08, 0.62)
        # Keep the centre of the frame clear-ish: that gap is the sky.
        if rng.random() < 0.95 * math.exp(-(((x - 0.5) / 0.30) ** 2) - (((y - 0.33) / 0.26) ** 2)):
            continue
        r = rng.uniform(0.025, 0.085) * SIZE
        d.ellipse(
            [x * SIZE - r, y * SIZE - r, x * SIZE + r, y * SIZE + r],
            fill=int(rng.uniform(70, 200)),
        )
    leaves = soften(leaves, 4.0)
    mask_to_image(img, leaves, "#c8842c", 0.55)
    mask_to_image(img, soften(leaves, 9.0), "#6d3d16", 0.40)

    # Canopy closing over the top of the frame.
    over, d = new_mask()
    d.rectangle([0, 0, SIZE, int(SIZE * 0.16)], fill=255)
    mask_to_image(img, soften(over, 26.0), "#40260f", 0.75)

    # Undergrowth either side of the trail, dark enough to shape the path.
    verge, d = new_mask()
    d.polygon(
        [(0, 0.50 * SIZE), (0.44 * SIZE, 0.545 * SIZE), (0.20 * SIZE, SIZE), (0, SIZE)], fill=255
    )
    d.polygon(
        [(SIZE, 0.50 * SIZE), (0.57 * SIZE, 0.545 * SIZE), (0.86 * SIZE, SIZE), (SIZE, SIZE)],
        fill=255,
    )
    mask_to_image(img, soften(verge, 12.0), "#4a2c12", 0.8)

    # The trail: a wedge running back to the light.
    trail, d = new_mask()
    d.polygon(
        [
            (0.455 * SIZE, 0.545 * SIZE),
            (0.555 * SIZE, 0.545 * SIZE),
            (0.95 * SIZE, SIZE),
            (0.02 * SIZE, SIZE),
        ],
        fill=255,
    )
    mask_to_image(img, soften(trail, 6.0), "#c69756", 0.8)

    # Leaf litter, thicker in the foreground where the trail is wide.
    litter, d = new_mask()
    for _ in range(400):
        y = rng.uniform(0.56, 1.0)
        spread = 0.05 + (y - 0.545) * 1.9
        x = 0.5 + rng.uniform(-spread, spread)
        r = 1.0 + (y - 0.545) * 6.0 * rng.uniform(0.4, 1.2)
        d.ellipse(
            [x * SIZE - r, y * SIZE - r * 0.55, x * SIZE + r, y * SIZE + r * 0.55],
            fill=int(rng.uniform(60, 170)),
        )
    mask_to_image(img, soften(litter, 0.8), "#a8631f", 0.55)

    # A few slender trunks, thicker at the edges of frame where they are nearest.
    trunks, d = new_mask()
    for x, w, lean in (
        (0.02, 0.045, 10),
        (0.22, 0.016, -3),
        (0.35, 0.010, 1),
        (0.66, 0.012, 3),
        (0.80, 0.022, -5),
        (0.965, 0.05, 8),
    ):
        px, pw = x * SIZE, w * SIZE
        # Tapered: a trunk that is the same width top and bottom reads as a pole.
        taper = pw * 0.45
        d.polygon(
            [
                (px + taper, 0),
                (px + pw - taper * 0.5, 0),
                (px + pw + lean, 0.92 * SIZE),
                (px + lean, 0.92 * SIZE),
            ],
            fill=255,
        )
    mask_to_image(img, soften(trunks, 1.2), "#33200f", 0.85)
    return finish(img, rng, grain=0.014, vignette=0.30)


def skyline_from_the_roof() -> Image.Image:
    """City blocks at dusk, over the parapet of the roof they were shot from."""
    rng = np.random.default_rng(21)
    img = vertical_gradient("#1b2440", "#e08a58", gamma=2.6)
    radial_glow(img, 0.78, 0.60, 0.5, "#f6b06a", 0.4)

    skyline, d = new_mask()
    windows, wd = new_mask()
    x = -10
    while x < SIZE + 10:
        w = int(rng.uniform(0.05, 0.14) * SIZE)
        top = rng.uniform(0.30, 0.56) * SIZE
        d.rectangle([x, top, x + w, SIZE], fill=255)
        for row in range(int((SIZE * 0.78 - top) / 14)):
            for col in range(max(1, w // 16)):
                if rng.random() < 0.30:
                    wx = x + 6 + col * 16
                    wy = top + 9 + row * 14
                    wd.rectangle([wx, wy, wx + 4, wy + 6], fill=int(rng.uniform(120, 255)))
        x += w + int(rng.uniform(2, 10))
    mask_to_image(img, skyline, "#141a26", 0.94)
    mask_to_image(img, soften(windows, 0.6), "#ffd89a", 0.8)

    # The roof the photo was taken from: parapet across the bottom.
    roof, d = new_mask()
    d.rectangle([0, int(SIZE * 0.855), SIZE, SIZE], fill=255)
    mask_to_image(img, roof, "#0d1117", 0.96)
    edge, d = new_mask()
    d.rectangle([0, int(SIZE * 0.855), SIZE, int(SIZE * 0.868)], fill=255)
    mask_to_image(img, soften(edge, 1.0), "#4a5468", 0.55)
    return finish(img, rng, grain=0.013, vignette=0.28)


def ridge_above_the_lake() -> Image.Image:
    """Receding ridges over still water, with the haze that separates them."""
    rng = np.random.default_rng(44)
    img = vertical_gradient("#8fb6c9", "#e8f0ef", gamma=1.6)

    water_top = 0.615
    layers = [(0.40, "#7d99ab", 0.75), (0.475, "#5b7c90", 0.85), (0.555, "#3d5a6b", 0.95)]
    for base, colour, alpha in layers:
        m, d = new_mask()
        fill_ridge(d, ridge_points(rng, base, 0.055, 0.55))
        mask_to_image(img, soften(m, 0.7), colour, alpha)

    # Lake: the ridge above it, mirrored, blurred and cooled.
    reflection = Image.fromarray((np.clip(img, 0, 1) * 255).astype(np.uint8))
    reflection = reflection.transpose(Image.FLIP_TOP_BOTTOM).filter(ImageFilter.GaussianBlur(3.5))
    refl = np.asarray(reflection, dtype=np.float64) / 255.0
    offset = int(SIZE * (1 - water_top * 2))
    refl = np.roll(refl, -offset, axis=0)
    band = (yy() >= water_top)[:, 0]
    img[band] = refl[band] * 0.72 + hexcol("#2b4b5c") * 0.28

    mist, d = new_mask()
    d.rectangle([0, int(SIZE * (water_top - 0.03)), SIZE, int(SIZE * (water_top + 0.02))], fill=255)
    mask_to_image(img, soften(mist, 7.0), "#dfeaea", 0.55)
    return finish(img, rng, grain=0.010, vignette=0.20)


def first_snow_back_field() -> Image.Image:
    """A fence line and a fir treeline over an untracked field."""
    rng = np.random.default_rng(3)
    img = vertical_gradient("#b9c6d2", "#eef2f6", gamma=1.5)

    # Two tree lines: a hazy far one, then the near one, both irregular. Firs, so
    # the silhouette is spiky rather than the scalloped hedge a sine wave gives.
    def treeline(base: float, min_h: float, max_h: float, step: float) -> Image.Image:
        m, dd = new_mask()
        x = -0.05
        while x < 1.06:
            h = rng.uniform(min_h, max_h)
            w = rng.uniform(0.5, 1.1) * step
            dd.polygon(
                [
                    ((x - w) * SIZE, base * SIZE),
                    (x * SIZE, (base - h) * SIZE),
                    ((x + w) * SIZE, base * SIZE),
                ],
                fill=255,
            )
            x += rng.uniform(0.5, 1.3) * step
        dd.rectangle([0, base * SIZE, SIZE, (base + 0.008) * SIZE], fill=255)
        return m

    mask_to_image(img, soften(treeline(0.495, 0.03, 0.075, 0.030), 2.6), "#8798a4", 0.55)
    mask_to_image(img, soften(treeline(0.525, 0.05, 0.115, 0.024), 1.1), "#404f55", 0.8)

    # Field: cool white, brightest where the last light is.
    field = np.clip((yy() - 0.525) / 0.475, 0, 1)[..., None]
    snow = np.repeat(hexcol("#dbe6ef") * (1 - field) + hexcol("#fafcff") * field, SIZE, axis=1)
    t = np.clip((yy() - 0.525) / 0.02, 0, 1)[..., None]
    np.copyto(img, img * (1 - t) + snow * t)

    # Drifts rather than ruled furrows: shallow curves that flatten with distance.
    drifts, d = new_mask()
    for i in range(9):
        y0 = 0.55 + i * 0.052
        pts = [
            (x / 40 * SIZE, (y0 + 0.35 * math.sin(x / 6.0 + i) * (y0 - 0.52) ** 1.4) * SIZE)
            for x in range(41)
        ]
        d.line(pts, fill=int(90 + 14 * i), width=2 + i // 2)
    mask_to_image(img, soften(drifts, 4.0), "#aec4d9", 0.7)

    posts, d = new_mask()
    for x, h, w in ((0.13, 0.20, 7), (0.42, 0.15, 5), (0.72, 0.11, 4)):
        top = (0.62 - h * 0.35) * SIZE
        bottom = (0.66 + h) * SIZE
        d.rectangle([x * SIZE, top, x * SIZE + w, bottom], fill=255)
    d.line([0.13 * SIZE, 0.60 * SIZE, 0.42 * SIZE, 0.585 * SIZE], fill=150, width=2)
    d.line([0.42 * SIZE, 0.585 * SIZE, 0.72 * SIZE, 0.60 * SIZE], fill=150, width=2)
    mask_to_image(img, soften(posts, 0.6), "#3f4a4f", 0.8)
    return finish(img, rng, grain=0.009, vignette=0.16)


SCENES = {
    "porch-at-sunset": porch_at_sunset,
    "beach-outer-banks": beach_outer_banks,
    "cabin-trail-october": cabin_trail_october,
    "skyline-from-the-roof": skyline_from_the_roof,
    "ridge-above-the-lake": ridge_above_the_lake,
    "first-snow-back-field": first_snow_back_field,
}


def main() -> None:
    """Write every scene to this directory."""
    for name, build in SCENES.items():
        path = OUT_DIR / f"{name}.jpg"
        build().save(path, "JPEG", quality=82, optimize=True, progressive=False)
        print(f"{path.name}  {path.stat().st_size / 1024:.0f} KB")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
make-icon.py - build the HOT-Step CPP desktop application icon.

The project ships only a 400x133 wordmark (ui/public/logo.webp), which is
useless as an app icon: a .desktop entry needs a square, and wordmarks stop
being legible below about 64px. So the icon is composed here from the brand's
own visual language, sampled out of that logo:

  background   near-black          #0b0b10  (the logo's backdrop, and the
                                           splash window's colour, so the
                                           icon and the window match)
  bolt         orange -> magenta   #f97316 -> #d946ef
                                           (the two bolts and the glow ring
                                           across the top of the logo)

Rendered at 4x and downsampled, because a hard-edged polygon aliased badly at
menu sizes.

Usage:  python3 make-icon.py [outdir]
Needs:  Pillow
"""

import os
import sys

from PIL import Image, ImageDraw, ImageFilter

SS = 4  # supersample factor

BG_TOP = (18, 16, 26)
BG_BOTTOM = (8, 8, 13)
BORDER = (58, 48, 82)
ORANGE = (249, 115, 22)
MAGENTA = (217, 70, 239)
CREAM = (255, 242, 208)

# One bold bolt reads at 48px; the logo's pair of thin bolts do not.
BOLT = [
    (0.615, 0.085),
    (0.300, 0.545),
    (0.455, 0.545),
    (0.375, 0.930),
    (0.720, 0.470),
    (0.560, 0.470),
]

SIZES = [16, 24, 32, 48, 64, 128, 256, 512]


def rounded_gradient(size, radius):
    """Dark rounded square with a soft vertical gradient and a hairline edge."""
    w = h = size
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    grad = Image.new("RGBA", (1, h))
    for y in range(h):
        t = y / max(1, h - 1)
        grad.putpixel(
            (0, y),
            tuple(round(BG_TOP[i] + (BG_BOTTOM[i] - BG_TOP[i]) * t) for i in range(3)) + (255,),
        )
    grad = grad.resize((w, h))
    mask = Image.new("L", (w, h), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, w - 1, h - 1], radius=radius, fill=255)
    img.paste(grad, (0, 0), mask)

    edge = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    ImageDraw.Draw(edge).rounded_rectangle(
        [0, 0, w - 1, h - 1], radius=radius, outline=BORDER + (200,), width=max(1, size // 256)
    )
    img.alpha_composite(edge)
    return img


def bolt_gradient(size, pts):
    """Fill a polygon with a diagonal orange -> magenta gradient."""
    w = h = size
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    x0, x1 = min(xs) * w, max(xs) * w
    y0, y1 = min(ys) * h, max(ys) * h

    # Project each pixel onto the bolt's long axis (top-right to bottom-left)
    # so the gradient runs the same way the bolt does.
    ax, ay = 0.72, 0.10
    bx, by = 0.34, 0.90
    dx, dy = bx - ax, by - ay
    denom = dx * dx + dy * dy

    grad = Image.new("RGBA", (w, h))
    px = grad.load()
    for y in range(int(y0) - 1, int(y1) + 2):
        for x in range(int(x0) - 1, int(x1) + 2):
            # Project in normalised coordinates: x/y are pixel indices here,
            # while ax..by are fractions of the icon, and mixing the two makes
            # every t clamp to 1 (a flat magenta bolt).
            nx, ny = x / w, y / h
            t = ((nx - ax) * dx + (ny - ay) * dy) / denom
            t = 0.0 if t < 0 else (1.0 if t > 1 else t)
            px[x, y] = tuple(
                round(ORANGE[i] + (MAGENTA[i] - ORANGE[i]) * t) for i in range(3)
            ) + (255,)

    mask = Image.new("L", (w, h), 0)
    ImageDraw.Draw(mask).polygon([(x * w, y * h) for x, y in pts], fill=255)
    out = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    out.paste(grad, (0, 0), mask)
    return out


def build(size):
    """Compose one icon at `size` px, supersampled."""
    big = size * SS
    img = rounded_gradient(big, radius=int(big * 0.19))
    pts = [(x, y) for x, y in BOLT]

    # Glow: blur the bolt and lay it underneath, so it reads as emissive like
    # the logo's lightning rather than as flat vector art.
    bolt = bolt_gradient(big, pts)
    glow = bolt.filter(ImageFilter.GaussianBlur(radius=big * 0.045))
    img.alpha_composite(Image.blend(Image.new("RGBA", (big, big), (0, 0, 0, 0)), glow, 0.75))
    img.alpha_composite(bolt)

    # A thin cream highlight along the bolt's leading edge, as in the logo.
    hl = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    ImageDraw.Draw(hl).line(
        [(0.615 * big, 0.085 * big), (0.300 * big, 0.545 * big)],
        fill=CREAM + (150,), width=max(1, int(big * 0.012)),
    )
    img.alpha_composite(hl.filter(ImageFilter.GaussianBlur(radius=big * 0.006)))

    return img.resize((size, size), Image.LANCZOS)


def main():
    outdir = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.abspath(__file__))
    os.makedirs(outdir, exist_ok=True)
    for size in SIZES:
        path = os.path.join(outdir, f"hot-step-cpp-{size}.png")
        build(size).save(path, "PNG", optimize=True)
        print(f"  {size:>3}px  {path}")
    # A 512 copy is what the .desktop file references.
    build(512).save(os.path.join(outdir, "hot-step-cpp.png"), "PNG", optimize=True)
    print(f"  512px  {os.path.join(outdir, 'hot-step-cpp.png')} (default name)")


if __name__ == "__main__":
    main()
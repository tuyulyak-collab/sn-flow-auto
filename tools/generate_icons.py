#!/usr/bin/env python3
"""Generate SN Flow Auto icons (16/48/128).

Pure-stdlib PNG generation (no Pillow / external deps). Produces a flat icon
that approximates the gradient ``linear-gradient(135deg, #e1eec3 0%, #f05053 100%)``
plus a soft "SN" mark. Chrome accepts non-square shapes but we stick with the
exact tile sizes Chrome expects.
"""

import os
import struct
import zlib

# Endpoints of the requested gradient
GRAD_START = (0xE1, 0xEE, 0xC3)  # #e1eec3 (mint cream)
GRAD_END = (0xF0, 0x50, 0x53)    # #f05053 (coral red)
INK = (0x4A, 0x1C, 0x1C)         # warm dark for the SN glyph
BG = (0xFF, 0xFA, 0xF3)          # warm white background


def lerp(a, b, t):
    return int(round(a + (b - a) * t))


def gradient_color(x, y, size):
    # 135deg gradient — bottom-right corner is the "end" stop
    t = ((x + y) / (2 * (size - 1))) if size > 1 else 0.0
    t = max(0.0, min(1.0, t))
    r = lerp(GRAD_START[0], GRAD_END[0], t)
    g = lerp(GRAD_START[1], GRAD_END[1], t)
    b = lerp(GRAD_START[2], GRAD_END[2], t)
    return (r, g, b, 255)


def make_canvas(size):
    return [[(BG[0], BG[1], BG[2], 255) for _ in range(size)] for _ in range(size)]


def draw_rounded_rect_with_gradient(canvas, x0, y0, x1, y1, radius):
    size = len(canvas)
    for y in range(y0, y1):
        for x in range(x0, x1):
            in_corner = False
            cx = cy = None
            if x < x0 + radius and y < y0 + radius:
                cx, cy = x0 + radius, y0 + radius; in_corner = True
            elif x >= x1 - radius and y < y0 + radius:
                cx, cy = x1 - radius - 1, y0 + radius; in_corner = True
            elif x < x0 + radius and y >= y1 - radius:
                cx, cy = x0 + radius, y1 - radius - 1; in_corner = True
            elif x >= x1 - radius and y >= y1 - radius:
                cx, cy = x1 - radius - 1, y1 - radius - 1; in_corner = True
            if in_corner:
                dx = x - cx; dy = y - cy
                if dx * dx + dy * dy > radius * radius:
                    continue
            canvas[y][x] = gradient_color(x, y, size)


def stamp_rect(canvas, x0, y0, x1, y1, color):
    size = len(canvas)
    x0, y0 = max(0, x0), max(0, y0)
    x1, y1 = min(size, x1), min(size, y1)
    for y in range(y0, y1):
        for x in range(x0, x1):
            canvas[y][x] = color


def draw_sn_glyph(canvas, size):
    """Draw a stylized "SN" using filled rectangles (very low fidelity but recognizable)."""
    bar = max(1, size // 14)
    cx = size // 2
    cy = size // 2

    # S — three horizontal bars + connectors (left top, right middle, left bottom inverted)
    # We approximate it as: top bar, middle bar, bottom bar + small vertical pieces.
    s_left = cx - bar * 4
    s_right = cx - bar * 1
    s_top = cy - bar * 3
    s_bot = cy + bar * 3
    s_mid = cy
    color = (INK[0], INK[1], INK[2], 255)
    stamp_rect(canvas, s_left, s_top, s_right, s_top + bar, color)
    stamp_rect(canvas, s_left, s_mid - bar // 2, s_right, s_mid + bar // 2 + 1, color)
    stamp_rect(canvas, s_left, s_bot - bar, s_right, s_bot, color)
    stamp_rect(canvas, s_left, s_top, s_left + bar, s_mid, color)
    stamp_rect(canvas, s_right - bar, s_mid, s_right, s_bot, color)

    # N — two vertical bars + diagonal (approximated with stairs)
    n_left = cx + bar * 1
    n_right = cx + bar * 4
    n_top = cy - bar * 3
    n_bot = cy + bar * 3
    stamp_rect(canvas, n_left, n_top, n_left + bar, n_bot, color)
    stamp_rect(canvas, n_right - bar, n_top, n_right, n_bot, color)
    # diagonal — step from top-left of N to bottom-right
    steps = bar * 6
    for i in range(steps):
        t = i / max(1, steps - 1)
        x = int(n_left + t * (n_right - n_left - bar))
        y = int(n_top + t * (n_bot - n_top - 1))
        stamp_rect(canvas, x, y, x + bar, y + max(1, bar // 2), color)


def write_png(path, canvas):
    size = len(canvas)
    raw = bytearray()
    for row in canvas:
        raw.append(0)  # filter type none
        for (r, g, b, a) in row:
            raw += bytes((r, g, b, a))

    def chunk(tag, data):
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    idat = zlib.compress(bytes(raw), 9)
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)


def draw_icon(size):
    canvas = make_canvas(size)
    pad = max(1, size // 12)
    radius = max(2, size // 5)
    draw_rounded_rect_with_gradient(canvas, pad, pad, size - pad, size - pad, radius)
    draw_sn_glyph(canvas, size)
    return canvas


def main():
    out_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "icons")
    out_dir = os.path.abspath(out_dir)
    os.makedirs(out_dir, exist_ok=True)
    for s in (16, 48, 128):
        canvas = draw_icon(s)
        path = os.path.join(out_dir, f"icon{s}.png")
        write_png(path, canvas)
        print(f"wrote {path} ({s}x{s})")


if __name__ == "__main__":
    main()

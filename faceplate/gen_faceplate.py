#!/usr/bin/env python3
"""Pulsar Touch faceplate in the Synthux Simple Touch drawing style.

Writes faceplate.svg (board proportions 600 x 972, same coordinates as the
board photo / browser replica). Default layer only — no modifier legends.
Hand-drawn look: every line is a slightly wobbly path drawn twice; the
randomness is seeded, so the output is reproducible.

    python3 gen_faceplate.py
"""
import math, os, random

W, H = 600, 972
INK = "#d6d3cc"
DIM = "#8e8b85"
random.seed(1967)  # year the first pulsar was detected

out = []
def add(s): out.append(s)

# ---------------------------------------------------------------- helpers
def wob(pts, amp=0.9):
    return [(x + random.uniform(-amp, amp), y + random.uniform(-amp, amp)) for x, y in pts]

def path(pts, closed=False):
    """Catmull-Rom through points -> smooth cubic path."""
    if closed:
        pts = pts + pts[:3]
    d = f"M{pts[0][0]:.1f},{pts[0][1]:.1f}"
    for i in range(len(pts) - 3 if closed else len(pts) - 1):
        p0 = pts[i - 1] if i > 0 else pts[i]
        p1, p2 = pts[i], pts[i + 1]
        p3 = pts[i + 2] if i + 2 < len(pts) else p2
        c1 = (p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6)
        c2 = (p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6)
        d += f" C{c1[0]:.1f},{c1[1]:.1f} {c2[0]:.1f},{c2[1]:.1f} {p2[0]:.1f},{p2[1]:.1f}"
    return d + (" Z" if closed else "")

def line(pts, w=1.4, color=INK, passes=2, amp=0.8, closed=False, opacity=1):
    for k in range(passes):
        add(f'<path d="{path(wob(pts, amp), closed)}" fill="none" stroke="{color}" '
            f'stroke-width="{w if k == 0 else w * 0.6:.2f}" stroke-linecap="round" stroke-linejoin="round" '
            f'opacity="{opacity if k == 0 else opacity * 0.7:.2f}"/>')

def seg(x1, y1, x2, y2, n=6):
    return [(x1 + (x2 - x1) * t / n, y1 + (y2 - y1) * t / n) for t in range(n + 1)]

def circle_pts(cx, cy, r, n=28, noise=0.0):
    return [(cx + (r + random.uniform(-noise, noise)) * math.cos(2 * math.pi * k / n),
             cy + (r + random.uniform(-noise, noise)) * math.sin(2 * math.pi * k / n)) for k in range(n)]

def rcircle(cx, cy, r, w=1.6, color=INK, noise=0.7, passes=2):
    line(circle_pts(cx, cy, r, max(18, int(r * 1.2)), noise), w, color, passes, 0.4, closed=True)

def text(x, y, s, size=15, anchor="middle", color=INK, rotate=None, spacing=1.2, weight="normal", cls="t"):
    tr = f' transform="rotate({rotate} {x} {y})"' if rotate is not None else ""
    add(f'<text x="{x}" y="{y}" class="{cls}" font-size="{size}" text-anchor="{anchor}" fill="{color}" '
        f'letter-spacing="{spacing}" font-weight="{weight}"{tr}>{s}</text>')

def stars(x0, y0, x1, y1, n, avoid=()):
    for _ in range(n):
        x, y = random.uniform(x0, x1), random.uniform(y0, y1)
        if any((x - ax) ** 2 + (y - ay) ** 2 < ar ** 2 for ax, ay, ar in avoid):
            continue
        r = random.random()
        if r < 0.7:
            add(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{random.uniform(0.4, 1.1):.2f}" fill="{INK}" opacity="{random.uniform(0.35, 0.9):.2f}"/>')
        elif r < 0.92:  # little shards
            a, s = random.uniform(0, 6.28), random.uniform(1.5, 3.5)
            pts = [(x + s * math.cos(a + k * 2.1), y + s * math.sin(a + k * 2.1)) for k in range(3)]
            add(f'<polygon points="{" ".join(f"{px:.1f},{py:.1f}" for px, py in pts)}" fill="{INK}" opacity="{random.uniform(0.4, 0.8):.2f}"/>')
        else:          # tiny crosses
            s = random.uniform(1.5, 2.5)
            add(f'<path d="M{x-s:.1f},{y:.1f}H{x+s:.1f}M{x:.1f},{y-s:.1f}V{y+s:.1f}" stroke="{INK}" stroke-width="0.6" opacity="0.6"/>')

# ---------------------------------------------------------------- layout (board coordinates)
KNOBS = {  # id: (x, y, label)
    "S31": (127, 350, "FREQ"), "S32": (243, 350, "CLUSTER"),
    "S33": (360, 350, "SHAPE"),   "S34": (473, 350, "WINDOW"),
    "S30": (127, 478, "SPREAD"),  "S35": (473, 478, "MASK"),
}
KR = 27          # knob cap radius
PANEL_BOTTOM = 582
FADERS = {"S36": (38, "LEVEL"), "S37": (562, "THICK · RATE · GLIDE")}
PADS = {  # pad: (x, y, r, label)
    "P00": (145, 622, 40, "OCT −"), "P01": (310, 612, 40, "CONV"), "P02": (418, 624, 40, "OCT +"),
    "P03": (52, 800, 52, "1"), "P04": (170, 760, 62, "2"), "P05": (285, 792, 50, "3"),
    "P06": (410, 782, 62, "4"), "P07": (552, 828, 48, "5"), "P08": (190, 912, 56, "6"),
    "P09": (410, 918, 56, "7"),
}

add(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}">')
add("""<style>
@import url('https://fonts.googleapis.com/css2?family=Patrick+Hand+SC&amp;display=swap');
.t { font-family: 'Patrick Hand SC', 'Chalkboard SE', 'Comic Neue', 'Comic Sans MS', sans-serif; }
</style>""")
add(f'<rect width="{W}" height="{H}" rx="14" fill="#050505"/>')

# ---------------------------------------------------------------- panel outline (curved cutout, as on Synthux faceplates)
panel = [(8, 70), (60, 66), (150, 64), (205, 70), (240, 92), (268, 140), (300, 196),
         (335, 232), (380, 248), (460, 252), (592, 252), (592, PANEL_BOTTOM), (8, PANEL_BOTTOM)]
line(panel + [(8, 70)], 1.3, DIM, passes=1, amp=0.3)
line([(8, 4), (592, 4), (592, 968), (8, 968), (8, 4)], 1.0, DIM, passes=1, amp=0.2)

# ---------------------------------------------------------------- top logo strip (shared board art): SIMPLE TOUCH, pad hint P10
text(300, 28, "SIMPLE", 13, color=DIM, spacing=4)
text(300, 62, "TOUCH", 42, spacing=10)
for x, lab in ((232, "TAP"), (373, "")):
    rcircle(x, 46, 22, 1.0, DIM, 0.6, 1)
    if lab:
        text(x, 80, lab, 11, color=DIM, spacing=2)

# jacks OUT / IN
for y, lab in ((122, "IN"), (236, "OUT")):
    rcircle(42, y, 30, 2.4); rcircle(42, y, 22, 1.2, DIM, 0.4, 1)
text(42, 172, "IN · OUT", 11, color=DIM, spacing=2)
line(seg(18, 162, 30, 158, 3), 1, DIM, 1); line(seg(54, 158, 66, 162, 3), 1, DIM, 1)

# cutout: SYNTHUX ACADEMY + a pulsar (neutron star with two beams and pulse rings)
text(330, 205, "SYNTHUX", 21, spacing=3)
text(330, 228, "ACADEMY", 21, spacing=3)
line(seg(330, 150, 330, 182, 4), 1.2); line(seg(392, 222, 430, 222, 4), 1.2); line(seg(338, 240, 338, 262, 3), 1.2)
px, py = 470, 150
rcircle(px, py, 6, 2.0)
for ang in (-35, 145):  # lighthouse beams
    a1, a2 = math.radians(ang - 9), math.radians(ang + 9)
    L = 62
    line([(px, py), (px + L * math.cos(a1), py + L * math.sin(a1))], 1.0, INK, 1, 0.5)
    line([(px, py), (px + L * math.cos(a2), py + L * math.sin(a2))], 1.0, INK, 1, 0.5)
    for k in range(1, 7):
        rr = 9 + k * 8
        aa = [math.radians(ang - 8 + 16 * j / 6) for j in range(7)]
        line([(px + rr * math.cos(a), py + rr * math.sin(a)) for a in aa], 0.7, INK, 1, 0.3, opacity=1 - k * 0.12)
for k in range(3):
    rcircle(px, py, 14 + k * 9, 0.6, DIM, 0.5, 1)
stars(250, 100, 590, 245, 140, avoid=[(330, 215, 70), (px, py, 22)])
stars(80, 80, 240, 250, 60, avoid=[(42, 122, 34), (42, 236, 34)])

# ---------------------------------------------------------------- panel starfield (avoid knobs, labels, faders)
avoid = [(x, y, KR + 22) for x, y, _ in KNOBS.values()] + [(300, 548, 120), (322, 470, 60)]
stars(66, 262, 534, 575, 900, avoid)
stars(12, 262, 26, 575, 30); stars(574, 262, 590, 575, 30)

# ---------------------------------------------------------------- knobs: cap + rough outer ring + label
def knob(x, y, label, ring=True):
    if ring:
        rcircle(x, y, KR + 9, 1.3, INK, 1.2)
    add(f'<circle cx="{x}" cy="{y}" r="{KR}" fill="#8f8d89" stroke="#111" stroke-width="2"/>')
    add(f'<circle cx="{x}" cy="{y}" r="{KR - 5}" fill="none" stroke="#6f6d69" stroke-width="1.5"/>')
    a = math.radians(-60)
    add(f'<line x1="{x}" y1="{y}" x2="{x + (KR - 6) * math.sin(a):.1f}" y2="{y - (KR - 6) * math.cos(a):.1f}" '
        f'stroke="#111" stroke-width="4" stroke-linecap="round"/>')
    if label:
        text(x, y + KR + (44 if not ring else 26), label, 15, spacing=1.5)

for k, (x, y, lab) in KNOBS.items():
    knob(x, y, lab, ring=k not in ("S35",))

# group headers with ornaments
def header(x1, x2, y, title, ornament):
    cx = (x1 + x2) / 2
    text(cx, y + 5, title, 17, spacing=2.5)
    tw = len(title) * 6.5
    ornament(x1, cx - tw - 6, y); ornament(cx + tw + 6, x2, y)

def resonance(xa, xb, y):  # little formant peak
    n = 24
    pts = []
    for i in range(n + 1):
        t = i / n
        xx = xa + (xb - xa) * t
        pk = 1 / (1 + ((t - 0.5) * 9) ** 2)
        pts.append((xx, y - 2 - 9 * pk))
    line(pts, 1.1, INK, 2, 0.3)

def burst(xa, xb, y):      # windowed sine burst (a pulsaret)
    n = 60
    pts = []
    for i in range(n + 1):
        t = i / n
        env = math.exp(-0.5 * ((t - 0.5) / 0.2) ** 2)
        pts.append((xa + (xb - xa) * t, y - 1 + 8 * env * math.sin(t * 2 * math.pi * 5)))
    line(pts, 0.9, INK, 1, 0.15)

header(90, 280, 296, "FORMANT", resonance)
header(323, 510, 296, "PULSARET", burst)

# SPREAD: three small formant arcs beside the knob
for k in range(3):
    r = KR + 16 + k * 7
    line([(127 + r * math.cos(a), 478 + r * math.sin(a)) for a in [math.radians(d) for d in range(-50, 51, 10)]],
         1.0, INK, 1, 0.4, opacity=1 - k * 0.25)

# MASK: ring of pulse dots in a burst:rest pattern (3 on, 1 off), like the decorated knob on Synthux plates
for i in range(32):
    if i % 4 == 3:
        continue
    a = 2 * math.pi * i / 32 - math.pi / 2
    r1, r2 = KR + 8, KR + 8 + (14 if i % 4 == 0 else 9)
    line([(473 + r1 * math.cos(a), 478 + r1 * math.sin(a)), (473 + r2 * math.cos(a), 478 + r2 * math.sin(a))], 1.4, INK, 1, 0.4)
    add(f'<circle cx="{473 + (r2 + 4) * math.cos(a):.1f}" cy="{478 + (r2 + 4) * math.sin(a):.1f}" r="1.3" fill="{INK}"/>')

# centre glyph: a masked pulsar train (bursts with rests, windows decaying)
gx, gy = 260, 470
for i in range(9):
    if i in (3, 7):
        add(f'<circle cx="{gx + i * 14}" cy="{gy}" r="1.2" fill="{DIM}"/>')
        continue
    h = 18 * (1 - 0.06 * i)
    pts = [(gx + i * 14 + dx, gy - h * math.exp(-((dx - 0.5) / 2.2) ** 2) * math.cos(dx * 1.9)) for dx in [d * 0.5 for d in range(-8, 10)]]
    line(pts, 1.1, INK, 1, 0.2)
line(seg(gx - 10, gy, gx + 9 * 14, gy, 20), 0.6, DIM, 1, 0.3)

# ---------------------------------------------------------------- faders: slot + vertical label
for k, (x, lab) in FADERS.items():
    line([(x - 8, 322), (x - 8, 538), (x + 8, 538), (x + 8, 322), (x - 8, 322)], 1.8, INK, 2, 0.5)
    add(f'<rect x="{x - 6}" y="{410}" width="12" height="26" rx="3" fill="#8f8d89" stroke="#111" stroke-width="1.5"/>')
    tx = x + (24 if k == "S36" else -24)
    text(tx, 430, lab, 14 if k == "S36" else 12, rotate=-90, spacing=2)
# hatch texture beside the level fader (as on TouchString's DRIVE)
for i in range(16):
    y = 300 + i * 4
    line(seg(14, y, 26, y - 2, 2), 0.6, DIM, 1, 0.4)

# ---------------------------------------------------------------- title
text(300, 528, "SIMPLE", 11, color=DIM, spacing=3)
text(300, 558, "TOUCH PULSAR", 30, spacing=4)
text(418, 558, "V.09", 11, anchor="start", color=DIM, spacing=1)

# ---------------------------------------------------------------- pad area: organic pads with flowing contour lines
def blob(cx, cy, r, seed):
    rnd = random.Random(seed)
    k = [rnd.uniform(0.82, 1.18) for _ in range(9)]
    return [(cx + r * k[i] * math.cos(2 * math.pi * i / 9) * 1.05, cy + r * k[i] * math.sin(2 * math.pi * i / 9) * 0.95)
            for i in range(9)]

# background: faceted triangles filled with fine parallel hatching (board texture, as on Synthux plates)
cols, rows = 10, 7
x0, y0, x1, y1 = 8, PANEL_BOTTOM + 2, 592, 966
gp = [[(x0 + (x1 - x0) * i / cols + (random.uniform(-18, 18) if 0 < i < cols else 0),
        y0 + (y1 - y0) * j / rows + (random.uniform(-16, 16) if 0 < j < rows else 0))
       for i in range(cols + 1)] for j in range(rows + 1)]
tri_id = 0
for j in range(rows):
    for i in range(cols):
        a, b, c, d = gp[j][i], gp[j][i + 1], gp[j + 1][i + 1], gp[j + 1][i]
        for tri in ((a, b, c), (a, c, d)) if random.random() < 0.5 else ((a, b, d), (b, c, d)):
            tri_id += 1
            cid = f"f{tri_id}"
            pts = " ".join(f"{px_:.1f},{py_:.1f}" for px_, py_ in tri)
            add(f'<clipPath id="{cid}"><polygon points="{pts}"/></clipPath>')
            ang = random.uniform(0, math.pi)
            gap = random.uniform(3.2, 5.0)
            cx_ = sum(p[0] for p in tri) / 3; cy_ = sum(p[1] for p in tri) / 3
            dx, dy = math.cos(ang), math.sin(ang)
            nx, ny = -dy, dx
            d = ""
            for k in range(-22, 23):
                ox, oy = cx_ + nx * k * gap, cy_ + ny * k * gap
                d += f"M{ox - dx * 90:.1f},{oy - dy * 90:.1f}L{ox + dx * 90:.1f},{oy + dy * 90:.1f}"
            add(f'<path d="{d}" stroke="#4d4b47" stroke-width="0.55" clip-path="url(#{cid})"/>')
            add(f'<polygon points="{pts}" fill="none" stroke="#6a6762" stroke-width="0.7"/>')

for k, (x, y, r, lab) in PADS.items():
    base = blob(x, y, r, sum(map(ord, k)))
    add(f'<path d="{path(base, True)}" fill="#050505"/>')
    for j in range(7):  # nested contours give the carved, wood-grain look
        s = 1 - j * 0.13
        pts = [(x + (px_ - x) * s + random.uniform(-1.2, 1.2), y + (py_ - y) * s + random.uniform(-1.2, 1.2)) for px_, py_ in base]
        line(pts, 1.4 if j == 0 else 0.7, INK if j == 0 else DIM, 1, 0.5, closed=True)
    # label tag
    tw = 9 + len(lab) * 7
    add(f'<rect x="{x - tw / 2:.1f}" y="{y - 10}" width="{tw:.1f}" height="20" rx="4" fill="#050505" stroke="{INK}" stroke-width="1"/>')
    text(x, y + 6, lab, 14, spacing=1)

# switches: slot + 3-position legend
def switch(x, y, labels, side):
    # slot + lever; up label above, down label below, centre label to the side (keeps clear of the pads)
    line([(x - 9, y - 22), (x + 9, y - 22), (x + 9, y + 22), (x - 9, y + 22), (x - 9, y - 22)], 1.6, INK, 2, 0.4)
    add(f'<circle cx="{x}" cy="{y - 10}" r="5.5" fill="#8f8d89" stroke="#111" stroke-width="1.5"/>')
    text(x, y - 30, labels[0], 11, spacing=1)
    text(x, y + 38, labels[2], 11, spacing=1)
    tx = x + 15 * side
    text(tx, y + 4, labels[1], 10, anchor="start" if side > 0 else "end", color=DIM, spacing=1)

switch(215, 640, ["TONE", "FREE", "RHYTHM"], +1)
switch(330, 692, ["BURST", "CHAN", "STOCH"], +1)

add("</svg>")
here = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(here, "faceplate.svg"), "w") as f:
    f.write("\n".join(out))
print("wrote faceplate.svg,", len(out), "elements")

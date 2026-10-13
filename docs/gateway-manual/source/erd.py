"""Tiny ER-diagram renderer (matplotlib): tables placed on a grid, crow's-foot-ish links."""
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch

ROW = 0.32
HEAD = 0.46
CHAR = 0.085


def table_size(table):
    width = max([len(table["name"]) * 0.105 + 0.4] +
                [len(c[0]) * CHAR + len(c[1]) * 0.075 + 0.9 for c in table["cols"]])
    return max(width, 2.6), HEAD + ROW * len(table["cols"]) + 0.12


def render(path, title, tables, links, colors, width=None, height=None):
    """tables: {key: {name, x, y, domain, cols:[(col, type, flags)]}} with x,y = top-left in inches.
    links: [(table_a, col_a, table_b, col_b, label)] — a 'many' end at a, 'one' end at b."""
    for t in tables.values():
        t["w"], t["h"] = table_size(t)
        if t.get("wfix"):
            t["w"] = t["wfix"]
    W = width or max(t["x"] + t["w"] for t in tables.values()) + 0.4
    H = height or max(t["y"] + t["h"] for t in tables.values()) + 0.4
    fig = plt.figure(figsize=(W, H), dpi=160)
    ax = fig.add_axes([0, 0, 1, 1])
    ax.set_xlim(0, W)
    ax.set_ylim(H, 0)
    ax.axis("off")
    fig.patch.set_facecolor("white")
    ax.text(0.3, 0.42, title, fontsize=15, fontweight="bold", color="#14342B", va="center")

    def col_y(t, col):
        for i, c in enumerate(t["cols"]):
            if c[0] == col:
                return t["y"] + HEAD + ROW * i + ROW / 2
        return t["y"] + HEAD / 2

    for link in links:
        a, ca, b, cb, label = link[:5]
        dash = "--" if len(link) > 5 and link[5] else "-"
        ta, tb = tables[a], tables[b]
        ya, yb = col_y(ta, ca), col_y(tb, cb)
        if ta["x"] + ta["w"] < tb["x"]:
            xa, xb, da, db = ta["x"] + ta["w"], tb["x"], 1, -1
        elif tb["x"] + tb["w"] < ta["x"]:
            xa, xb, da, db = ta["x"], tb["x"] + tb["w"], -1, 1
        else:  # stacked vertically: route around the left side
            xa, xb, da, db = ta["x"], tb["x"], -1, -1
        mid = (xa + xb) / 2 if da != db else min(xa, xb) - 0.35
        ax.plot([xa, xa + 0.18 * da], [ya, ya], color="#5B6B66", lw=1.2, zorder=1, ls=dash)
        ax.plot([xa + 0.18 * da, mid, mid, xb + 0.18 * db], [ya, ya, yb, yb], color="#5B6B66", lw=1.2, zorder=1, ls=dash)
        ax.plot([xb + 0.18 * db, xb], [yb, yb], color="#5B6B66", lw=1.2, zorder=1, ls=dash)
        # many end (crow's foot) at a, one end (bar) at b
        for dy in (-0.09, 0, 0.09):
            ax.plot([xa + 0.18 * da, xa], [ya, ya + dy], color="#5B6B66", lw=1.2, zorder=1)
        ax.plot([xb + 0.1 * db, xb + 0.1 * db], [yb - 0.09, yb + 0.09], color="#5B6B66", lw=1.4, zorder=1)
        if label:
            ax.text(mid + 0.05, (ya + yb) / 2, label, fontsize=7.5, color="#5B6B66", style="italic",
                    va="center", ha="left", zorder=4,
                    bbox=dict(boxstyle="round,pad=0.15", fc="white", ec="none"))

    for t in tables.values():
        color = colors.get(t.get("domain"), "#1F6F5C")
        ax.add_patch(FancyBboxPatch((t["x"], t["y"]), t["w"], t["h"], boxstyle="round,pad=0,rounding_size=0.08",
                                    fc="white", ec=color, lw=1.6, zorder=2))
        ax.add_patch(FancyBboxPatch((t["x"], t["y"]), t["w"], HEAD, boxstyle="round,pad=0,rounding_size=0.08",
                                    fc=color, ec=color, lw=1.6, zorder=3))
        ax.text(t["x"] + 0.14, t["y"] + HEAD / 2, t["name"], fontsize=10, fontweight="bold", color="white",
                va="center", zorder=4)
        for i, (name, typ, flags) in enumerate(t["cols"]):
            y = t["y"] + HEAD + ROW * i + ROW / 2
            if i % 2:
                ax.add_patch(plt.Rectangle((t["x"] + 0.03, y - ROW / 2), t["w"] - 0.06, ROW, fc="#F2F6F4",
                                           ec="none", zorder=2.5))
            tag = "PK" if "PK" in flags else ("FK" if "FK" in flags else ("UQ" if "UQ" in flags else ""))
            ax.text(t["x"] + 0.12, y, tag, fontsize=7, fontweight="bold",
                    color="#B5651D" if tag == "PK" else "#2E6DA4", va="center", zorder=4)
            ax.text(t["x"] + 0.45, y, name, fontsize=8.5, color="#14342B", va="center", zorder=4,
                    fontweight="bold" if tag == "PK" else "normal")
            ax.text(t["x"] + t["w"] - 0.12, y, typ, fontsize=7.5, color="#6B7A75", va="center", ha="right",
                    zorder=4, family="monospace")
    fig.savefig(path, dpi=160, facecolor="white")
    plt.close(fig)

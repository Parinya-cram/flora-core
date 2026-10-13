import sys
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch

OUT = sys.argv[1]
INK, MUTED = "#14342B", "#5B6B66"


def canvas(w, h, title):
    fig = plt.figure(figsize=(w, h), dpi=160)
    ax = fig.add_axes([0, 0, 1, 1])
    ax.set_xlim(0, w); ax.set_ylim(h, 0); ax.axis("off")
    ax.text(0.3, 0.42, title, fontsize=15, fontweight="bold", color=INK, va="center")
    return fig, ax


def box(ax, x, y, w, h, title, sub="", fc="#1F6F5C", tc="white", ec=None, fs=10, sfs=7.8):
    ax.add_patch(FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0,rounding_size=0.1",
                                fc=fc, ec=ec or fc, lw=1.4, zorder=2))
    if sub:
        ax.text(x + w / 2, y + h / 2 - 0.13, title, ha="center", va="center", fontsize=fs, fontweight="bold",
                color=tc, zorder=3)
        ax.text(x + w / 2, y + h / 2 + 0.17, sub, ha="center", va="center", fontsize=sfs, color=tc, zorder=3,
                alpha=0.92)
    else:
        ax.text(x + w / 2, y + h / 2, title, ha="center", va="center", fontsize=fs, fontweight="bold",
                color=tc, zorder=3)


def zone(ax, x, y, w, h, label, fc):
    ax.add_patch(FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0,rounding_size=0.15", fc=fc, ec="none",
                                zorder=0))
    ax.text(x + 0.15, y + 0.22, label, fontsize=9, fontweight="bold", color=MUTED, va="center", zorder=1)


def arrow(ax, p, q, label="", color=MUTED, dashed=False, rad=0.0, lpos=0.5, loff=(0, -0.12), both=False):
    ax.add_patch(FancyArrowPatch(p, q, arrowstyle="<|-|>" if both else "-|>", mutation_scale=11, color=color,
                                 lw=1.3, ls="--" if dashed else "-", connectionstyle=f"arc3,rad={rad}",
                                 zorder=1.5))
    if label:
        x = p[0] + (q[0] - p[0]) * lpos + loff[0]
        y = p[1] + (q[1] - p[1]) * lpos + loff[1]
        ax.text(x, y, label, fontsize=7.5, color=color, ha="center", va="center", style="italic", zorder=4,
                bbox=dict(boxstyle="round,pad=0.12", fc="white", ec="none", alpha=0.9))


# 1. Platform context ---------------------------------------------------------
fig, ax = canvas(13, 6.6, "Where the Gateway sits in ESM Flora")
zone(ax, 0.3, 0.8, 3.0, 5.5, "Cloud", "#EEF1F6")
zone(ax, 3.6, 0.8, 4.0, 5.5, "Hospital data centre", "#EEF5F1")
zone(ax, 7.9, 0.8, 4.8, 5.5, "Ward / OR / ICU network", "#F6F2EC")
box(ax, 0.6, 1.4, 2.4, 1.0, "Flora Root", "licences · signed releases", fc="#1E2761")
box(ax, 3.9, 1.4, 3.4, 1.0, "Flora Canopy", "topology · config · alerts", fc="#1E4E79")
box(ax, 3.9, 3.1, 2.9, 1.0, "Haber (in Canopy)", "check-in · licence · registry", fc="#6B4F2A")
box(ax, 8.2, 3.1, 2.4, 1.0, "Flora Gateway", "this manual", fc="#1F6F5C")
box(ax, 8.2, 1.4, 2.4, 1.0, "Leaf workstation", "bedside chart", fc="#5A7D2A")
for i, (t, s) in enumerate([("Patient monitors", "HL7 · IACS · DRI"), ("Anaesthesia / vent.", "MEDIBUS · COM 1.2"),
                            ("Infusion pumps", "B. Braun BCC")]):
    box(ax, 10.9, 1.25 + i * 1.45, 1.6, 1.05, t, s, fc="white", tc=INK, ec="#B9C7C1", fs=8.2, sfs=7)
arrow(ax, (3.0, 1.9), (3.9, 1.9), "bundles,\nreleases", loff=(0, -0.3))
arrow(ax, (5.35, 3.1), (5.35, 2.4), "forward\ncheck-ins", loff=(0.55, 0), both=True)
arrow(ax, (8.2, 3.45), (6.8, 3.45), "check-in / 20 s", loff=(0, -0.2))
arrow(ax, (6.8, 3.8), (8.2, 3.8), "licence · config", loff=(0, 0.2))
arrow(ax, (9.4, 3.1), (9.4, 2.4), "data-api\n(observations)", loff=(0.62, 0))
arrow(ax, (8.2, 1.9), (7.3, 1.9), "case sync", dashed=True, loff=(0, -0.2))
for i in range(3):
    arrow(ax, (10.9, 1.78 + i * 1.45), (10.6, 3.6), rad=0.0)
ax.text(0.6, 5.2, "Releases flow Root → Haber registry → Gateway updater (signature verified, hospital approved).",
        fontsize=8.5, color=MUTED)
ax.text(0.6, 5.6, "Device data never leaves the hospital: Leafs read it from the Gateway on the local network.",
        fontsize=8.5, color=MUTED)
fig.savefig(f"{OUT}/arch-1-context.png", dpi=160, facecolor="white"); plt.close(fig)

# 2. Gateway internals / data flow --------------------------------------------
fig, ax = canvas(13.5, 7.4, "Inside the Gateway: from device bytes to Leaf observations")
zone(ax, 0.3, 0.8, 2.3, 6.3, "Devices", "#F6F2EC")
zone(ax, 2.9, 0.8, 2.6, 6.3, "Ingress controllers (Rust)", "#EEF5F1")
zone(ax, 5.8, 0.8, 2.3, 6.3, "Kafka 3.9 (KRaft)", "#EEEFF7")
zone(ax, 8.4, 0.8, 2.4, 6.3, "Processing", "#EEF5F1")
zone(ax, 11.1, 0.8, 2.1, 6.3, "Store & serve", "#EEF1F6")
devs = [("RS-232 devices", "MEDIBUS · COM 1.2 · DRI"), ("HL7 v2 monitors", "MLLP · TCP"),
        ("Dräger M540 / Vista", "UDP multicast · TCP 9500"), ("HTTP devices", "poll / push JSON")]
ctrls = [("serial-controller", ":7401 admin"), ("socket-controller", "7421/7422/9500"),
         ("feeder-controller", "HTTP poll"), ("webhook-controller", ":7423 POST")]
for i, (t, s) in enumerate(devs):
    box(ax, 0.45, 1.3 + i * 1.4, 2.0, 0.95, t, s, fc="white", tc=INK, ec="#C9B9A2", fs=8.4, sfs=7)
for i, (t, s) in enumerate(ctrls):
    box(ax, 3.05, 1.3 + i * 1.4, 2.3, 0.95, t, s, fc="#1F6F5C", fs=9, sfs=7.2)
for a, b in [(0, 0), (1, 1), (2, 1), (3, 2), (3, 3)]:
    arrow(ax, (2.45, 1.78 + a * 1.4), (3.05, 1.78 + b * 1.4))
topics = [("gw.raw.<pod>", "RawFrame"), ("gw.cmd.<pod>", "Command"), ("gw.obs", "Observation"),
          ("gw.measurements", "Dräger fields"), ("gw.logs", "LogEvent")]
for i, (t, s) in enumerate(topics):
    box(ax, 5.95, 1.25 + i * 1.12, 2.0, 0.8, t, s, fc="#444C8A", fs=8.6, sfs=7)
arrow(ax, (5.35, 2.3), (5.95, 1.65), "frames")
arrow(ax, (5.95, 2.77), (5.35, 3.1), "polls / ACK", loff=(0, 0.2))
box(ax, 8.55, 1.3, 2.1, 1.3, "Parser container", "device-medical-service\none per device", fc="#2C7A7B",
    sfs=7)
box(ax, 8.55, 3.0, 2.1, 0.95, "publisher", "push to HTTP targets", fc="#2C7A7B", sfs=7)
box(ax, 8.55, 4.3, 2.1, 1.1, "gateway-service", "admin UI · licence · alerts\nstarts parsers (Docker)", fc="#B5651D", sfs=7)
box(ax, 8.55, 5.75, 2.1, 0.95, "collector", "batch → Postgres", fc="#2C7A7B", sfs=7)
arrow(ax, (7.95, 1.65), (8.55, 1.75), "consume")
arrow(ax, (8.55, 2.35), (7.95, 2.77))
arrow(ax, (8.55, 2.5), (7.95, 3.6), "obs")
arrow(ax, (7.95, 3.75), (8.55, 3.45))
arrow(ax, (7.95, 3.75), (8.55, 6.05))
arrow(ax, (7.95, 4.85), (8.55, 6.15))
arrow(ax, (7.95, 5.95), (8.55, 6.3))
box(ax, 11.25, 1.3, 1.8, 0.95, "PostgreSQL 17", "flora_gateway", fc="#1E4E79", sfs=7)
box(ax, 11.25, 2.65, 1.8, 0.95, "server (axum)", "read API :8080", fc="#1E4E79", sfs=7)
box(ax, 11.25, 4.0, 1.8, 0.95, "Kong 3.9", "/data-api/<leaf>", fc="#1E4E79", sfs=7)
box(ax, 11.25, 5.35, 1.8, 0.95, "nginx edge", "HTTPS :443 / 7443", fc="#1E2761", sfs=7)
ax.plot([10.65, 10.97, 10.97], [6.0, 6.0, 1.78], color=MUTED, lw=1.3, zorder=1.5)
arrow(ax, (10.97, 1.78), (11.25, 1.78))
ax.text(10.97, 3.95, "insert", rotation=90, fontsize=7.5, color=MUTED, style="italic", ha="center", va="center", bbox=dict(boxstyle="round,pad=0.1", fc="white", ec="none"))
arrow(ax, (12.15, 2.25), (12.15, 2.65))
arrow(ax, (12.15, 3.6), (12.15, 4.0))
arrow(ax, (12.15, 4.95), (12.15, 5.35))
arrow(ax, (10.65, 5.2), (11.25, 5.7))
arrow(ax, (12.15, 6.3), (12.15, 6.95), "Leaf / browser", loff=(0, 0.02))
fig.savefig(f"{OUT}/arch-2-dataflow.png", dpi=160, facecolor="white"); plt.close(fig)

# 3. Check-in / control loop ----------------------------------------------------
fig, ax = canvas(13, 6.2, "Control loop: check-in, licence, configuration and reconcile")
lanes = [("Gateway", 1.4, "#1F6F5C"), ("Haber", 5.0, "#6B4F2A"), ("Canopy", 8.3, "#1E4E79"),
         ("Parser containers", 11.3, "#2C7A7B")]
for name, x, c in lanes:
    box(ax, x - 0.9, 0.8, 1.8, 0.55, name, fc=c, fs=9.5)
    ax.plot([x, x], [1.35, 5.9], color="#C8D2CE", lw=1.2, ls="--", zorder=0)
steps = [
    (1.4, 5.0, 1.75, "1  POST /gateways/{id}/checkin  (devices, site, applied version)"),
    (5.0, 8.3, 2.2, "2  forward config → snapshot if hash changed"),
    (8.3, 5.0, 2.65, "3  desired_config (clone · location · Leaf wizard)"),
    (5.0, 1.4, 3.1, "4  licence · device types · parser images · canopy_config"),
    (1.4, 1.4, 3.6, ""),
    (1.4, 11.3, 4.25, "6  reconcile: start / stop / upgrade one parser per cycle"),
    (1.4, 5.0, 4.9, "7  POST /gateways/{id}/alerts  →  Canopy alert inbox"),
]
for x1, x2, y, label in steps:
    if x1 == x2:
        ax.add_patch(FancyBboxPatch((x1 - 0.85, y - 0.2), 1.7, 0.4, boxstyle="round,pad=0,rounding_size=0.08",
                                    fc="#FFF6E5", ec="#E0B46A", zorder=3))
        ax.text(x1, y, "5  apply config", fontsize=7.8, ha="center", va="center", zorder=4, color=INK)
        continue
    arrow(ax, (x1, y), (x2, y))
    ax.text((x1 + x2) / 2, y - 0.14, label, fontsize=8, ha="center", va="bottom", color=INK, zorder=4,
            bbox=dict(boxstyle="round,pad=0.1", fc="white", ec="none"))
ax.text(0.5, 5.6, "Runs every GATEWAY_SYNC_INTERVAL_SEC (20 s). With Canopy offline the gateway keeps the last licence; "
        "a revoked or expired licence stops every parser.", fontsize=8.5, color=MUTED)
fig.savefig(f"{OUT}/arch-3-control-loop.png", dpi=160, facecolor="white"); plt.close(fig)
print("ok")

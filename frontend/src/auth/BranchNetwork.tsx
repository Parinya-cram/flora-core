import { useEffect, useState, type RefObject } from "react";

/**
 * Decorative sign-in background: Flora Root's branching network in two shapes.
 *   tree   (Canopy) - Root turned upside down: branches rise from a seed at the bottom;
 *                     the glowing tips are the Leaves that sync into Canopy.
 *   flower (Leaf)   - the Flora logo (four leaves and the head) traced around the sign-in
 *                     card (fitTo): black-and-white lines that draw themselves in, with Canopy's sparks,
 *                     glowing seed and tip halos.
 * Sparks travel along the branches. Same seed every visit; colours come from the
 * active app theme (--app-*).
 */

export type NetworkShape = "tree" | "flower";

/** draw: delay (s) of the line drawing itself in (the logo outline). */
type Branch = { d: string; width: number; draw?: number; spark?: { duration: number; begin: number } };
type Tip = { x: number; y: number; delay: number };

function random(seed: number) {
  let state = seed;
  return () => (state = (state * 16807) % 2147483647) / 2147483647;
}

type Frame = { x: number; y: number; width: number; height: number };
type Glow = { x: number; y: number; rx: number; ry: number; kind: string };

function buildNetwork(W: number, H: number, shape: NetworkShape, frame: Frame | null) {
  const rnd = random(7);
  const branches: Branch[] = [];
  const ends: { x: number; y: number }[] = [];
  const origin = { x: W / 2, y: H + 20 };

  function grow(x: number, y: number, angle: number, length: number, depth: number, width: number) {
    if (depth === 0 || y < -40) {
      ends.push({ x, y });
      return;
    }
    const x2 = x + Math.cos(angle) * length;
    const y2 = y + Math.sin(angle) * length;
    const cx = x + Math.cos(angle + (rnd() - 0.5) * 0.9) * length * 0.6;
    const cy = y + Math.sin(angle + (rnd() - 0.5) * 0.9) * length * 0.6;
    const branch: Branch = { d: `M${x.toFixed(1)},${y.toFixed(1)} Q${cx.toFixed(1)},${cy.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}`, width };
    if (depth >= 3 && rnd() > 0.45) branch.spark = { duration: 3 + rnd() * 4, begin: rnd() * 4 };
    branches.push(branch);
    const children = depth > 3 ? 2 : rnd() > 0.35 ? 2 : 1;
    for (let i = 0; i < children; i++) {
      grow(x2, y2, angle + (i - (children - 1) / 2) * (0.55 + rnd() * 0.35) + (rnd() - 0.5) * 0.3,
        length * (0.78 + rnd() * 0.12), depth - 1, Math.max(0.6, width * 0.72));
    }
  }

  if (shape === "flower") return buildFlower(W, H, frame, rnd);
  {
    const spread = Math.min(1.25, (W / H) * 0.75);
    for (let i = 0; i < 5; i++) grow(origin.x, origin.y, -Math.PI / 2 + (i - 2) * spread * 0.32, Math.min(W, H) * 0.2, 6, 3.2);
  }

  // Glowing tips that stay on screen, in the upper part of the page.
  const tips: Tip[] = ends
    .filter(p => p.x > 30 && p.x < W - 30 && p.y > 20 && p.y < H * 0.65)
    .filter((_, i) => i % 3 === 0)
    .slice(0, 14)
    .map((p, i) => ({ x: p.x, y: p.y, delay: (i * 0.37) % 4.8 }));
  return { branches, tips, seed: { x: origin.x, y: H - 6 }, glows: [] as Glow[] };
}

/** The Flora logo around the sign-in card: four leaves rising from one point and the head above them,
 *  traced in thin monochrome lines (logo artwork coordinates, 256 x 256, stretched to frame the card). */
const LOGO_LEAVES: { tip: [number, number]; edges: [number, number, number, number][]; rib: [number, number] }[] = [
  { tip: [8, 120], edges: [[92, 206, 32, 162], [118, 150, 58, 114]], rib: [64, 160] },   // pink, outer left
  { tip: [62, 58], edges: [[82, 180, 52, 108], [140, 148, 108, 78]], rib: [96, 130] },  // teal, inner left
  { tip: [208, 58], edges: [[136, 140, 168, 74], [206, 172, 222, 108]], rib: [180, 128] }, // blue, inner right
  { tip: [250, 118], edges: [[168, 150, 220, 112], [192, 206, 242, 160]], rib: [206, 158] }, // green, outer right
];
const LOGO_BASE: [number, number] = [136, 210];
const LOGO_HEAD = { x: 138, y: 62, r: 26 };

function buildFlower(W: number, H: number, frame: Frame | null, rnd: () => number) {
  const box = frame ?? { x: W / 2 - 450, y: H / 2 - 200, width: 900, height: 400 };
  // The outer leaves reach well past the card's sides, the head sits wholly above it and the
  // leaves meet below it, so the logo reads around the card.
  const reach = Math.min(260, Math.max(90, (W - box.width) / 2 - 24));
  const left = box.x - reach, right = box.x + box.width + reach;
  const headBottom = LOGO_HEAD.y + LOGO_HEAD.r;
  const sx = (right - left) / (250 - 8);
  const sy = (box.y + box.height + 90 - (box.y - 18)) / (LOGO_BASE[1] - headBottom);
  const map = (x: number, y: number) => [left + (x - 8) * sx, box.y - 18 + (y - headBottom) * sy];
  const at = (x: number, y: number) => map(x, y).map(v => v.toFixed(1)).join(",");
  const base = at(...LOGO_BASE);
  const branches: Branch[] = [];
  const tips: Tip[] = [];
  LOGO_LEAVES.forEach((leaf, index) => {
    const tip = at(...leaf.tip);
    leaf.edges.forEach(([c1x, c1y, c2x, c2y], side) => {
      // Sparks run out from the seed along every leaf edge, as on Canopy's tree.
      branches.push({ d: `M${base} C${at(c1x, c1y)} ${at(c2x, c2y)} ${tip}`, width: 2.2, draw: index * 0.25 + side * 0.1,
                      spark: { duration: 3 + rnd() * 4, begin: 1.5 + rnd() * 4 } });
    });
    branches.push({ d: `M${base} Q${at(...leaf.rib)} ${tip}`, width: 1.1, draw: index * 0.25 + 0.3,
                    spark: rnd() > 0.4 ? { duration: 4 + rnd() * 3, begin: 2 + rnd() * 4 } : undefined });
    const [x, y] = map(...leaf.tip);
    tips.push({ x, y, delay: index * 1.2 });
  });
  const [hx, hy] = map(LOGO_HEAD.x, LOGO_HEAD.y);
  const r = LOGO_HEAD.r * Math.min(sx, sy);
  branches.push({ d: `M${(hx - r).toFixed(1)},${hy.toFixed(1)} a${r.toFixed(1)},${r.toFixed(1)} 0 1,0 ${(2 * r).toFixed(1)},0 a${r.toFixed(1)},${r.toFixed(1)} 0 1,0 ${(-2 * r).toFixed(1)},0`,
                  width: 2.2, draw: 1.1, spark: { duration: 6, begin: 2.5 } });
  tips.push({ x: hx, y: hy - r, delay: 2.4 });
  const [bx, by] = map(...LOGO_BASE);
  // Light spreading from the seed up through the leaves, and a softer one behind the head.
  const glows = [{ x: bx, y: by, rx: (right - left) * 0.62, ry: (by - (hy - r)) * 1.05, kind: "seed" },
                 { x: hx, y: hy, rx: r * 3.2, ry: r * 3.2, kind: "head" }];
  return { branches, tips, seed: { x: bx, y: by }, glows };
}

function useViewport() {
  const [size, setSize] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  useEffect(() => {
    let timer = 0;
    const onResize = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setSize({ w: window.innerWidth, h: window.innerHeight }), 150);
    };
    window.addEventListener("resize", onResize);
    return () => { window.removeEventListener("resize", onResize); window.clearTimeout(timer); };
  }, []);
  return size;
}

/** Tracks an element's box on screen (the flower is fitted around it). */
function useFrame(target: RefObject<HTMLElement | null> | undefined) {
  const [frame, setFrame] = useState<Frame | null>(null);
  useEffect(() => {
    const element = target?.current;
    if (!element) return;
    const measure = () => {
      const r = element.getBoundingClientRect();
      setFrame({ x: r.left, y: r.top, width: r.width, height: r.height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    window.addEventListener("resize", measure);
    return () => { observer.disconnect(); window.removeEventListener("resize", measure); };
  }, [target]);
  return frame;
}

export default function BranchNetwork({ shape, fitTo }: { shape: NetworkShape; fitTo?: RefObject<HTMLElement | null> }) {
  const { w, h } = useViewport();
  const frame = useFrame(fitTo);
  const { branches, tips, seed, glows } = buildNetwork(w, h, shape, frame);
  return (
    <svg className={`canopy-tree${shape === "flower" ? " canopy-tree--mono" : ""}`} viewBox={`0 0 ${w} ${h}`} aria-hidden="true" focusable="false">
      {glows.length ? (
        <defs>
          {glows.map(glow => (
            <radialGradient key={glow.kind} id={`leaf-glow-${glow.kind}`}>
              <stop offset="0%" className={`canopy-glow__stop canopy-glow__stop--${glow.kind}`} />
              <stop offset="100%" className="canopy-glow__stop canopy-glow__stop--end" />
            </radialGradient>
          ))}
        </defs>
      ) : null}
      {glows.map(glow => (
        <ellipse key={glow.kind} className="canopy-glow" cx={glow.x} cy={glow.y} rx={glow.rx} ry={glow.ry} fill={`url(#leaf-glow-${glow.kind})`} />
      ))}
      {branches.map((branch, index) => (
        <g key={index}>
          <path className={`canopy-tree__branch${branch.draw != null ? " canopy-tree__branch--draw" : ""}`} d={branch.d}
            strokeWidth={branch.width.toFixed(2)} pathLength={branch.draw != null ? 1 : undefined}
            style={branch.draw != null ? { animationDelay: `${branch.draw}s` } : undefined} />
          {branch.spark ? (
            <circle className="canopy-tree__spark" r="1.8">
              <animateMotion dur={`${branch.spark.duration.toFixed(1)}s`} begin={`${branch.spark.begin.toFixed(1)}s`}
                repeatCount="indefinite" path={branch.d} />
            </circle>
          ) : null}
        </g>
      ))}
      {seed ? <circle className="canopy-tree__seed" cx={seed.x} cy={seed.y} r="10" /> : null}
      {tips.map((tip, index) => (
        <g key={index}>
          <circle className="canopy-tree__halo" cx={tip.x} cy={tip.y} r="4" style={{ animationDelay: `${tip.delay.toFixed(2)}s` }} />
          <circle className="canopy-tree__node" cx={tip.x} cy={tip.y} r="3.6" />
        </g>
      ))}
    </svg>
  );
}

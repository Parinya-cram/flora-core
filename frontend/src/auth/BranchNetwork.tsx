import { useEffect, useState, type RefObject } from "react";

/**
 * Decorative sign-in background: Flora Root's branching network in two shapes.
 *   tree   (Canopy) - Root turned upside down: branches rise from a seed at the bottom;
 *                     the glowing tips are the Leaves that sync into Canopy.
 *   flower (Leaf)   - one flower around the sign-in card (fitTo), just a little larger
 *                     than the card: teardrop petals in the same thin lines.
 * Sparks travel along the branches. Same seed every visit; colours come from the
 * active app theme (--app-*).
 */

export type NetworkShape = "tree" | "flower";

type Branch = { d: string; width: number; spark?: { duration: number; begin: number } };
type Tip = { x: number; y: number; delay: number };

function random(seed: number) {
  let state = seed;
  return () => (state = (state * 16807) % 2147483647) / 2147483647;
}

type Frame = { x: number; y: number; width: number; height: number };

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
  return { branches, tips, seed: { x: origin.x, y: H - 6 } };
}

/** One flower around the sign-in card: teardrop petals drawn with Root's thin lines. */
function buildFlower(W: number, H: number, frame: Frame | null, rnd: () => number) {
  const MARGIN = 60; // how far the petal tips reach past the card
  const box = frame ?? { x: W / 2 - 450, y: H / 2 - 100, width: 900, height: 200 };
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  // A unit petal reaches the edge of a box MARGIN larger than the card, so every petal tip,
  // the diagonal ones included, shows just outside the card.
  const rx = box.width / 2 + MARGIN;
  const ry = box.height / 2 + MARGIN;
  const reach = (angle: number) => Math.min(rx / Math.max(Math.abs(Math.cos(angle)), 1e-6), ry / Math.max(Math.abs(Math.sin(angle)), 1e-6));
  const branches: Branch[] = [];
  const tips: Tip[] = [];
  const point = (angle: number, r: number) => [cx + Math.cos(angle) * r * reach(angle), cy + Math.sin(angle) * r * reach(angle)];
  const at = (angle: number, r: number) => point(angle, r).map(v => v.toFixed(1)).join(",");
  const petal = (heading: number, length: number, open: number, width: number, glow: boolean) => {
    const tip = at(heading, length);
    // Two edges leave the centre, swell out and meet again at the tip.
    for (const side of [-1, 1]) {
      const d = `M${cx},${cy} C${at(heading + side * open, length * 0.55)} ${at(heading + side * open * 0.55, length * 0.98)} ${tip}`;
      branches.push({ d, width, spark: glow && side === 1 ? { duration: 4 + rnd() * 2, begin: rnd() * 4 } : undefined });
    }
    // Midrib and two side veins.
    branches.push({ d: `M${cx},${cy} Q${at(heading + (rnd() - 0.5) * 0.06, length * 0.45)} ${at(heading, length * 0.82)}`, width: width * 0.55 });
    for (const side of [-1, 1]) {
      branches.push({ d: `M${at(heading, length * 0.32)} Q${at(heading + side * 0.1, length * 0.5)} ${at(heading + side * 0.14, length * 0.66)}`, width: width * 0.45 });
    }
    if (glow) {
      const [x, y] = point(heading, length);
      tips.push({ x, y, delay: (tips.length * 0.6) % 4.8 });
    }
  };
  // Eight petals: four to the sides of the card and four to its corners; a shorter inner ring between them.
  const corner = Math.atan2(ry, rx);
  const headings = [-Math.PI / 2, -corner, 0, corner, Math.PI / 2, Math.PI - corner, Math.PI, Math.PI + corner];
  headings.forEach(heading => petal(heading, 1, 0.16, 1.5, true));
  headings.forEach((heading, i) => {
    const next = headings[(i + 1) % headings.length] + (i === headings.length - 1 ? 2 * Math.PI : 0);
    petal((heading + next) / 2, 0.72, 0.14, 1, false);
  });
  return { branches, tips, seed: { x: cx, y: cy } };
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
  const { branches, tips, seed } = buildNetwork(w, h, shape, frame);
  return (
    <svg className="canopy-tree" viewBox={`0 0 ${w} ${h}`} aria-hidden="true" focusable="false">
      {branches.map((branch, index) => (
        <g key={index}>
          <path className="canopy-tree__branch" d={branch.d} strokeWidth={branch.width.toFixed(2)} />
          {branch.spark ? (
            <circle className="canopy-tree__spark" r="1.8">
              <animateMotion dur={`${branch.spark.duration.toFixed(1)}s`} begin={`${branch.spark.begin.toFixed(1)}s`}
                repeatCount="indefinite" path={branch.d} />
            </circle>
          ) : null}
        </g>
      ))}
      <circle className="canopy-tree__seed" cx={seed.x} cy={seed.y} r="10" />
      {tips.map((tip, index) => (
        <g key={index}>
          <circle className="canopy-tree__halo" cx={tip.x} cy={tip.y} r="4" style={{ animationDelay: `${tip.delay.toFixed(2)}s` }} />
          <circle className="canopy-tree__node" cx={tip.x} cy={tip.y} r="3.6" />
        </g>
      ))}
    </svg>
  );
}

// A tree that grows on the Canopy sign-in page: the trunk rises from a seedling, branches
// spread, leaf clusters open into a canopy, then it sways gently. With reduced motion it
// appears fully grown. `busy` (signing in) makes the canopy breathe a little faster.

const TRUNK = "M120 206 C121 186 116 168 119 150 C121 136 118 124 120 110";
const BRANCHES = [
  { d: "M119 152 C108 144 96 140 82 128", delay: 1.0 },
  { d: "M120 140 C132 132 146 130 160 118", delay: 1.15 },
  { d: "M120 124 C112 112 102 104 94 90", delay: 1.3 },
  { d: "M120 118 C128 106 138 98 148 86", delay: 1.4 },
  { d: "M120 112 C120 100 121 88 120 76", delay: 1.5 },
  { d: "M86 131 C78 128 70 126 62 118", delay: 1.55 },
  { d: "M156 121 C164 118 172 114 180 106", delay: 1.6 },
];
// Leaf clusters: [cx, cy, r, shade 0..2]; back layer first so the front overlaps it.
const LEAVES: Array<[number, number, number, number]> = [
  [72, 112, 26, 0], [168, 100, 27, 0], [120, 62, 30, 0], [96, 80, 26, 1], [146, 76, 27, 1],
  [58, 120, 18, 1], [184, 106, 19, 1], [82, 98, 22, 2], [158, 94, 22, 2], [120, 84, 28, 2],
  [104, 104, 20, 2], [138, 108, 20, 2], [120, 46, 18, 1],
];

export default function GrowingTree({ busy = false }: { busy?: boolean }) {
  return (
    <div className={`canopy-tree ${busy ? "is-busy" : ""}`} aria-hidden="true">
      <style>{`
        .canopy-tree { --tree-trunk:#8a6440; --tree-leaf-0:#4f8a5b; --tree-leaf-1:#5fa06a; --tree-leaf-2:#77b97c; --tree-ground:rgba(110,90,60,.22); }
        :root[data-theme="dark"] .canopy-tree, .dark .canopy-tree { --tree-trunk:#b08a62; --tree-leaf-0:#3f7a4c; --tree-leaf-1:#55935f; --tree-leaf-2:#6fae75; --tree-ground:rgba(220,200,160,.16); }
        .canopy-tree svg { display:block; width:100%; height:auto; overflow:visible }
        .canopy-tree .ground { fill:var(--tree-ground); transform-box:fill-box; transform-origin:center; animation:tree-ground .6s ease-out both }
        .canopy-tree .sprout { fill:var(--tree-leaf-2); transform-box:fill-box; transform-origin:bottom center; animation:tree-sprout 1.2s ease-in-out .2s both }
        .canopy-tree .wood { fill:none; stroke:var(--tree-trunk); stroke-linecap:round; stroke-dasharray:1; stroke-dashoffset:1 }
        .canopy-tree .trunk { stroke-width:9; animation:tree-draw 1.1s cubic-bezier(.45,.05,.3,1) .4s forwards }
        .canopy-tree .branch { stroke-width:4.5; animation:tree-draw .7s ease-out forwards }
        .canopy-tree .leaf { transform-box:fill-box; transform-origin:center; transform:scale(0); animation:tree-leaf .7s cubic-bezier(.3,1.5,.5,1) forwards }
        .canopy-tree .leaf.s0 { fill:var(--tree-leaf-0) } .canopy-tree .leaf.s1 { fill:var(--tree-leaf-1) } .canopy-tree .leaf.s2 { fill:var(--tree-leaf-2) }
        .canopy-tree .crown { transform-origin:120px 206px; animation:tree-sway 6s ease-in-out 3.2s infinite }
        .canopy-tree.is-busy .crown { animation-duration:1.6s }
        @keyframes tree-ground { from { transform:scaleX(0); opacity:0 } }
        @keyframes tree-sprout { 0% { transform:scale(0) } 45% { transform:scale(1) } 100% { transform:scale(0); opacity:0 } }
        @keyframes tree-draw { to { stroke-dashoffset:0 } }
        @keyframes tree-leaf { to { transform:scale(1) } }
        @keyframes tree-sway { 0%,100% { transform:rotate(0deg) } 50% { transform:rotate(1.4deg) } }
        @media (prefers-reduced-motion: reduce) {
          .canopy-tree * { animation:none !important }
          .canopy-tree .wood { stroke-dashoffset:0 } .canopy-tree .leaf { transform:none } .canopy-tree .sprout { display:none }
        }
      `}</style>
      <svg viewBox="30 14 180 200">
        <ellipse className="ground" cx="120" cy="207" rx="62" ry="5" />
        <path className="sprout" d="M120 206 C114 198 112 192 116 188 C119 192 120 198 120 206 C121 197 125 191 129 190 C129 196 125 202 120 206Z" />
        <g className="crown">
          <path className="wood trunk" pathLength={1} d={TRUNK} />
          {BRANCHES.map(branch => (
            <path key={branch.d} className="wood branch" pathLength={1} d={branch.d} style={{ animationDelay: `${branch.delay}s` }} />
          ))}
          {LEAVES.map(([cx, cy, r, shade], index) => (
            <circle key={`${cx}-${cy}`} className={`leaf s${shade}`} cx={cx} cy={cy} r={r} style={{ animationDelay: `${1.7 + index * 0.09}s` }} />
          ))}
        </g>
      </svg>
    </div>
  );
}

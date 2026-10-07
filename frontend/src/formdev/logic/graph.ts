/**
 * Logic graph (Phase 2.10): cycle detection and evaluation order. Twin of
 * services/flora-api/app/formdev/logic/graph.py (same deterministic, sorted output).
 */
export type Edges = Map<string, Set<string>>;

const sortedTargets = (edges: Edges, node: string) => [...(edges.get(node) ?? [])].sort();

/** Cycles found by a depth-first walk: at least one for every circular group, each once, starting at its smallest node. */
export function findCycles(edges: Edges): string[][] {
  const cycles: string[][] = [];
  const seen = new Set<string>();
  const done = new Set<string>();
  const walk = (node: string, stack: string[], onStack: Set<string>) => {
    for (const target of sortedTargets(edges, node)) {
      if (onStack.has(target)) {
        const cycle = stack.slice(stack.indexOf(target));
        const smallest = [...cycle].sort()[0];
        const start = cycle.indexOf(smallest);
        const rotated = [...cycle.slice(start), ...cycle.slice(0, start)];
        const key = rotated.join("\u0000");
        if (!seen.has(key)) {
          seen.add(key);
          cycles.push(rotated);
        }
      } else if (!done.has(target)) {
        stack.push(target);
        onStack.add(target);
        walk(target, stack, onStack);
        onStack.delete(target);
        stack.pop();
      }
    }
    done.add(node);
  };
  for (const node of [...edges.keys()].sort()) if (!done.has(node)) walk(node, [node], new Set([node]));
  return cycles.sort((a, b) => (a.join("\u0000") < b.join("\u0000") ? -1 : a.join("\u0000") > b.join("\u0000") ? 1 : 0));
}

/** Nodes ordered so every node comes after what it depends on (ties keep the given order). */
export function evaluationOrder(nodes: string[], edges: Edges): string[] {
  const order: string[] = [];
  const placed = new Set<string>();
  const visiting = new Set<string>();
  const place = (node: string) => {
    if (placed.has(node) || visiting.has(node)) return;
    visiting.add(node);
    for (const target of sortedTargets(edges, node)) place(target);
    visiting.delete(node);
    placed.add(node);
    order.push(node);
  };
  nodes.forEach(place);
  return order;
}

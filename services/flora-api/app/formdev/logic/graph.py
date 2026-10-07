"""Logic graph (Phase 2.10): which field depends on which, cycle detection and evaluation order.

Nodes are data paths: a top-level key ("bmi") or a repeat child ("meds.dose"). An edge node -> ref means
"node is computed or shown from ref". Twin: frontend/src/formdev/logic/graph.ts. Deterministic output
(sorted) so both runtimes report the same cycles.
"""
from __future__ import annotations


def find_cycles(edges: dict[str, set[str]]) -> list[list[str]]:
    """Cycles found by a depth-first walk: at least one for every group of fields that depend on each other
    in a circle, each reported once and starting at its smallest node. Nodes already fully explored are
    not walked again, which keeps this linear for real forms."""
    cycles: list[list[str]] = []
    seen: set[tuple[str, ...]] = set()
    done: set[str] = set()

    def walk(node: str, stack: list[str], on_stack: set[str]) -> None:
        for target in sorted(edges.get(node, ())):
            if target in on_stack:
                cycle = stack[stack.index(target):]
                start = cycle.index(min(cycle))
                rotated = tuple(cycle[start:] + cycle[:start])
                if rotated not in seen:
                    seen.add(rotated)
                    cycles.append(list(rotated))
            elif target not in done:
                stack.append(target)
                on_stack.add(target)
                walk(target, stack, on_stack)
                on_stack.discard(target)
                stack.pop()
        done.add(node)

    for node in sorted(edges):
        if node not in done:
            walk(node, [node], {node})
    return sorted(cycles)


def evaluation_order(nodes: list[str], edges: dict[str, set[str]]) -> list[str]:
    """Nodes ordered so every node comes after what it depends on (cycles are refused before this runs).
    Ties keep the given order."""
    order: list[str] = []
    placed: set[str] = set()
    visiting: set[str] = set()

    def place(node: str) -> None:
        if node in placed or node in visiting:
            return
        visiting.add(node)
        for target in sorted(edges.get(node, ())):
            place(target)
        visiting.discard(node)
        placed.add(node)
        order.append(node)

    for node in nodes:
        place(node)
    return order

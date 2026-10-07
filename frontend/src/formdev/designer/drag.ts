/** What is being dragged: a palette field type, a ready-made block, or a field already on the canvas. */
import type { FieldType } from "../core/types";
import type { FieldRef, Path } from "./model";

export type DragItem = { kind: "new"; type: FieldType } | { kind: "block"; id: string } | { kind: "move"; ref: FieldRef; span: number };
/** Where it lands: a field list, a position in it and, for free placement, a start column (null = flow). */
export type DropTarget = { list: Path; index: number; col: number | null };
/** HTML5 drag & drop needs some data on the event; the item itself travels in a shared ref. */
export const DRAG_MIME = "application/x-flora-formdev";

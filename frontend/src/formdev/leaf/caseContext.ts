/**
 * The case a Form Studio form is filled for (Flora Leaf: one case per encounter). Provided by the workflow form panel;
 * fields that read Leaf data (timeline) use it. Without a case (designer, Canopy) such fields are typed in.
 */
import { createContext } from "react";
import type { LeafCase } from "./timeline";

export const FormCaseContext = createContext<LeafCase | null>(null);

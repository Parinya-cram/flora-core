/**
 * Template library and AI form builder (Form Studio): the shapes of /api/formdev/ai/* and /api/formdev/templates.
 * Mirrors services/flora-api/app/routes/formdev_ai.py, app/formdev/documents.py and app/formdev/ai_builder.py.
 */
import type { FormDefinition, Issue } from "../core/types";

export type AiStatus = {
  configured: boolean;
  apiFormat: "anthropic" | "openai";
  model: string;
  /** OpenAI-compatible hosts cannot read PDFs: the browser sends every page as a PNG. */
  needsPageImages: boolean;
  limits: { files: number; fileBytes: number; totalBytes: number; pdfPages: number; pageImages: number };
};

export type DocumentKind = "pdf" | "image" | "docx" | "xlsx" | "text" | "form_json" | "legacy_office" | "unknown";

export type InspectedFile = {
  name: string;
  kind: DocumentKind;
  media_type: string;
  size: number;
  sha256: string;
  status: "ok" | "warning" | "error";
  notes: string[];
  pages: number | null;
  text_chars: number;
  has_text_layer: boolean | null;
  page_images: number;
  /** Validation problems of a flora.form/1 file. */
  issues?: DescribedIssue[];
};

export type Inspection = { files: InspectedFile[]; ok: boolean; errors: number; warnings: number };

export type DescribedIssue = Issue & { location?: string; message_th?: string };

export type CoverageItem = { source: string; item: string; field: string | null; found: boolean; note: string };

export type Placement = { phase: "preop" | "intraop" | "postop" | "any"; after_section: string | null; reason?: string };

export type AiReport = {
  document_type: string;
  summary: string;
  language: string;
  coverage: CoverageItem[];
  uncertain: Array<{ field: string | null; note: string }>;
  placement: Placement;
  missing: number;
  unknown_fields: string[];
  instructions?: string;
  model?: string;
  attempts?: number;
  usage?: { input_tokens: number; output_tokens: number; requests: number; seconds: number } | null;
};

export type TemplateSource = Pick<InspectedFile, "name" | "kind" | "media_type" | "size" | "sha256" | "pages" | "status" | "notes">;

export type TemplateRow = {
  template_id: string;
  title: string;
  description: string;
  origin: "ai" | "manual" | "import";
  status: "draft" | "reviewed";
  sources: TemplateSource[];
  version: number;
  created_at: number;
  created_by: string | null;
  updated_at: number;
  updated_by: string | null;
};

export type Template = TemplateRow & { definition: FormDefinition; report: AiReport | null };

export type TemplateWithIssues = { template: Template; issues: DescribedIssue[] };

export type GenerateResult = TemplateWithIssues & { inspection: Inspection; usage: AiReport["usage"] };

/** A file uploaded once, as it is (POST /api/formdev/uploads), then used by its id (a SHA-256). */
export type Upload = { id: string; name: string; size: number; media_type: string; kind: string; pages: number | null; uploaded_at: number };
export type UploadResult = { upload: Upload; file: InspectedFile };
export type GenerateRequest = { uploads: string[]; instructions?: string; form_id?: string; title?: string };

/** Where Flora Leaf shows a workflow form: the Workflow Studio phase and the built-in tab it follows. */
export const PLACEMENT_KEY = "flora.leaf_placement";

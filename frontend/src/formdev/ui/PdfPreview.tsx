/**
 * The A4 view as the PDF itself (Template phase): what is shown is exactly what prints and downloads, paper layout
 * included (boxed sections, page header / footer, score tables). The PDF is rebuilt shortly after the values change;
 * pdf-lib and the fonts load on first use, so they stay out of the main bundle.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { FontEntry, FormDefinition, RecordData, StyleEntry } from "../core/types";
import type { LookupTables } from "../logic/lookup";

type Props = {
  definition: FormDefinition; value: RecordData; recordId?: string; printedBy?: string; roles?: string[]; isAdmin?: boolean; lookups?: LookupTables;
  styles?: StyleEntry[]; fonts?: FontEntry[]; language?: string;
  /** Told after each build: pages printed and the density scale used (1 = normal). */
  onInfo?: (info: { pages: number; scale: number }) => void;
};
export type PdfPreviewHandle = { print: () => void };

const PdfPreview = forwardRef<PdfPreviewHandle, Props>(function PdfPreview(props, ref) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState("");
  const frame = useRef<HTMLIFrameElement>(null);
  const { definition, value, recordId, printedBy, roles, isAdmin, lookups, styles, fonts, language } = props;
  const onInfo = useRef(props.onInfo);
  useEffect(() => { onInfo.current = props.onInfo; });

  useImperativeHandle(ref, () => ({ print: () => frame.current?.contentWindow?.print() }), []);

  useEffect(() => {
    let cancelled = false;
    let made: string | null = null;
    const timer = setTimeout(() => {
      void import("../render/formPdf").then(({ buildFormPdfInfo }) => buildFormPdfInfo({ definition, value, recordId, printedBy, roles, isAdmin, lookups, styles, fonts, language }))
        .then(({ bytes, pages, scale }) => {
          if (cancelled) return;
          onInfo.current?.({ pages, scale });
          made = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/pdf" }));
          setUrl(made);
          setError("");
        })
        .catch(caught => { if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught)); });
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      if (made) setTimeout(() => URL.revokeObjectURL(made as string), 1000);
    };
  }, [definition, value, recordId, printedBy, roles, isAdmin, lookups, styles, fonts, language]);

  if (error) return <div role="alert" className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-600">{error}</div>;
  return url
    ? <iframe ref={frame} title={`${definition.title} (PDF)`} src={`${url}#view=FitH`} className="h-[1150px] w-full rounded-xl border border-[var(--app-border)] bg-white" />
    : <div className="flex h-40 items-center justify-center text-sm text-[var(--app-muted)]">…</div>;
});

export default PdfPreview;

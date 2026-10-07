import { useEffect, useState } from "react";
import { listLeafWorkflows, type LeafWorkflowOption } from "../../api/workflowApi";

/** The ward's workflows cached on this Leaf (empty when the ward has none or the endpoint is missing). */
export function useLeafWorkflows() {
  const [rows, setRows] = useState<LeafWorkflowOption[]>([]);
  useEffect(() => {
    let cancelled = false;
    void listLeafWorkflows()
      .then(result => { if (!cancelled) setRows(result.rows); })
      .catch(() => { if (!cancelled) setRows([]); });
    return () => { cancelled = true; };
  }, []);
  return rows;
}

/** Default workflow id for a new case: an admission preset (when offered here) wins over the ward default. */
export function defaultWorkflowId(rows: LeafWorkflowOption[], admissionWorkflowId?: string | null): string {
  if (admissionWorkflowId && rows.some(row => row.id === admissionWorkflowId)) return admissionWorkflowId;
  return rows.find(row => row.isDefault)?.id || rows[0]?.id || "";
}

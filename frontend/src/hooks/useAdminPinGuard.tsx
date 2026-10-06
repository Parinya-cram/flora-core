import { useCallback, useRef, useState, type ReactNode } from "react";
import { AdminPinError } from "../api/authApi";
import AdminPinDialog from "../components/common/AdminPinDialog";

/**
 * Wraps a user-management write with the Leaf admin-PIN prompt.
 * When `required` is false (Canopy) the action runs directly without a PIN.
 * The PIN lives only in this call's local scope; on an invalid PIN the prompt
 * re-opens with the server error so the user can retry.
 * Resolves to `false` when the user cancels.
 */
export function useAdminPinGuard(required: boolean): {
  runWithAdminPin: (action: (pin?: string) => Promise<void>) => Promise<boolean>;
  pinDialog: ReactNode;
} {
  const [prompt, setPrompt] = useState<{ open: boolean; error: string }>({ open: false, error: "" });
  const resolverRef = useRef<((pin: string | null) => void) | null>(null);

  const requestPin = useCallback((error: string) => new Promise<string | null>(resolve => {
    resolverRef.current = resolve;
    setPrompt({ open: true, error });
  }), []);

  const finish = useCallback((pin: string | null) => {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    setPrompt({ open: false, error: "" });
    resolve?.(pin);
  }, []);

  const runWithAdminPin = useCallback(async (action: (pin?: string) => Promise<void>) => {
    if (!required) {
      await action();
      return true;
    }
    let error = "";
    for (;;) {
      const pin = await requestPin(error);
      if (pin == null) return false;
      try {
        await action(pin);
        return true;
      } catch (err) {
        if (err instanceof AdminPinError) {
          error = err.message;
          continue;
        }
        throw err;
      }
    }
  }, [required, requestPin]);

  const onCancel = useCallback(() => finish(null), [finish]);
  const onSubmit = useCallback((pin: string) => finish(pin), [finish]);
  const pinDialog = <AdminPinDialog open={prompt.open} error={prompt.error} onSubmit={onSubmit} onCancel={onCancel} />;
  return { runWithAdminPin, pinDialog };
}

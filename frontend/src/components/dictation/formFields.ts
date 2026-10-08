/**
 * Reads the fields a form shows on screen (labels, options, current values) and
 * writes values back the way a user would, so React state updates normally.
 * Works on any rendered form: only visible, enabled controls under `root` count.
 */

export type DictationFieldType = "text" | "textarea" | "number" | "select" | "single" | "multi";

export type DictationField = {
  id: string;
  label: string;
  group?: string;
  section?: string;
  type: DictationFieldType;
  options?: string[];
  placeholder?: string;
  value?: string | string[];
};

export type ScannedField = DictationField & {
  element?: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  choices?: Array<{ text: string; input: HTMLInputElement }>;
};

const SKIPPED = new Set(["hidden", "file", "button", "submit", "reset", "image", "range", "color", "password"]);
const CONTROL = "input, select, textarea";

function clean(text: string | null | undefined): string {
  const line = (text || "").split("\n").map(s => s.trim()).find(Boolean) || "";
  return line.replace(/\s+/g, " ").replace(/\s*\*$/, "").slice(0, 80);
}

function visible(el: HTMLElement): boolean {
  return el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
}

/** Nearest text before `start` (walking up), skipping siblings that hold other controls. */
function precedingText(start: Element, root: Element): { text: string; level: Element } | null {
  let node: Element | null = start;
  while (node && node !== root) {
    let sibling = node.previousElementSibling;
    while (sibling) {
      if (!sibling.matches(CONTROL) && !sibling.querySelector(CONTROL)) {
        const text = clean((sibling as HTMLElement).innerText);
        if (text) return { text, level: node.parentElement || root };
      }
      sibling = sibling.previousElementSibling;
    }
    node = node.parentElement;
  }
  return null;
}

function labelFor(el: HTMLElement, root: Element): { label: string; level: Element | null } {
  const aria = clean(el.getAttribute("aria-label"));
  if (el.id) {
    const explicit = root.querySelector(`label[for="${CSS.escape(el.id)}"]`) as HTMLElement | null;
    if (explicit && clean(explicit.innerText)) return { label: clean(explicit.innerText), level: explicit.parentElement };
  }
  const found = precedingText(el, root);
  if (found) return { label: found.text, level: found.level };
  return { label: aria || clean((el as HTMLInputElement).placeholder) || "Field", level: null };
}

function sectionFor(level: Element | null, root: Element): string | undefined {
  if (!level) return undefined;
  return precedingText(level, root)?.text;
}

function choiceText(input: HTMLInputElement): string {
  const wrap = input.closest("label") as HTMLElement | null;
  const text = clean(wrap?.innerText) || clean(input.getAttribute("aria-label")) ||
    clean((input.nextElementSibling as HTMLElement | null)?.innerText) || input.value;
  return text;
}

export function scanFormFields(root: HTMLElement): ScannedField[] {
  const fields: ScannedField[] = [];
  const groups = new Map<string, ScannedField>();
  let next = 1;
  const controls = Array.from(root.querySelectorAll<HTMLElement>(CONTROL));
  for (const el of controls) {
    if (el.closest("[data-no-dictation]") || !visible(el)) continue;
    if ((el as HTMLInputElement).disabled || (el as HTMLInputElement).readOnly) continue;
    if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
      const text = choiceText(el);
      // Unlabelled toggles (switches, row selectors) are not something one dictates.
      if (!text || text === "on") continue;
      const anchor = el.closest("label") || el;
      const { label, level } = labelFor(anchor as HTMLElement, root);
      const section = sectionFor(level, root);
      const kind: DictationFieldType = el.type === "radio" ? "single" : "multi";
      const key = `${kind}|${el.type === "radio" && el.name ? el.name : ""}|${section}|${label}`;
      let group = groups.get(key);
      if (!group) {
        group = { id: `f${next++}`, label, section, type: kind, options: [], value: [], choices: [] };
        groups.set(key, group);
        fields.push(group);
      }
      group.choices!.push({ text, input: el });
      group.options!.push(text);
      if (el.checked) (group.value as string[]).push(text);
      continue;
    }
    const { label, level } = labelFor(el, root);
    const field: ScannedField = { id: `f${next++}`, label, section: sectionFor(level, root), type: "text", element: el as ScannedField["element"] };
    if (el instanceof HTMLSelectElement) {
      field.type = "select";
      field.options = Array.from(el.options).filter(o => o.value !== "").map(o => clean(o.text) || o.value);
      const picked = el.selectedOptions[0];
      if (picked && picked.value !== "") field.value = clean(picked.text) || picked.value;
    } else if (el instanceof HTMLTextAreaElement) {
      field.type = "textarea";
      field.placeholder = clean(el.placeholder) || undefined;
      field.value = el.value || undefined;
    } else if (el instanceof HTMLInputElement) {
      if (SKIPPED.has(el.type)) continue;
      field.type = el.type === "number" ? "number" : "text";
      field.placeholder = el.type === "date" ? "yyyy-mm-dd" : el.type === "time" ? "HH:mm"
        : el.type === "datetime-local" ? "yyyy-mm-ddTHH:mm" : clean(el.placeholder) || undefined;
      field.value = el.value || undefined;
      const list = el.list;
      if (list) field.options = Array.from(list.options).map(o => o.value).filter(Boolean).slice(0, 80);
    }
    fields.push(field);
  }
  return fields;
}

export function describeField(field: DictationField): string {
  return [field.section, field.label].filter(Boolean).join(" › ");
}

function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
    : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
}

/** Applies one value; returns false when the control is gone or the value does not fit. */
export function applyFieldValue(field: ScannedField, value: unknown): boolean {
  if (field.choices) {
    const wanted = new Set((Array.isArray(value) ? value : [value]).map(String));
    let changed = false;
    for (const choice of field.choices) {
      if (!wanted.has(choice.text) || !choice.input.isConnected) continue;
      if (!choice.input.checked) choice.input.click();
      changed = true;
    }
    return changed;
  }
  const el = field.element;
  if (!el || !el.isConnected) return false;
  if (el instanceof HTMLSelectElement) {
    const option = Array.from(el.options).find(o => (clean(o.text) || o.value) === String(value) || o.value === String(value));
    if (!option) return false;
    setNativeValue(el, option.value);
    return true;
  }
  setNativeValue(el, String(value));
  return true;
}

export function formatValue(value: unknown): string {
  if (value == null || value === "") return "—";
  return Array.isArray(value) ? (value.length ? value.join(", ") : "—") : String(value);
}

/**
 * Labels in the UI language. A form is written in one language (usually Thai) and may carry English next to it:
 * label_en on fields and options, title_en on sections and categories. English is shown when the UI is English and
 * the form has it; otherwise the form's own text. Older forms keep "ไทย / English" in one label and are shown as is.
 */
import type { CategoryDefinition, FieldDefinition, FieldOption, SectionDefinition } from "./types";

export const isEnglish = (language?: string) => Boolean(language && language.toLowerCase().startsWith("en"));

export function inLanguage(text: string, english: string | undefined, language?: string): string {
  return isEnglish(language) && english && english.trim() ? english : text;
}

export const fieldLabel = (field: Pick<FieldDefinition, "label" | "label_en">, language?: string) => inLanguage(field.label, field.label_en, language);
export const optionLabel = (option: Pick<FieldOption, "label" | "label_en">, language?: string) => inLanguage(option.label, option.label_en, language);
export const blockTitle = (block: Pick<SectionDefinition | CategoryDefinition, "title" | "title_en">, language?: string) =>
  inLanguage(block.title, block.title_en, language);

/** The field with its label and options in the UI language (for inputs that print field.label / option.label). */
export function localized(field: FieldDefinition, language?: string): FieldDefinition {
  if (!isEnglish(language)) return field;
  const options = field.options?.some(option => option.label_en) ? field.options.map(option => ({ ...option, label: optionLabel(option, language) })) : field.options;
  return { ...field, label: fieldLabel(field, language), ...(options ? { options } : {}) };
}

/** "น้ำหนัก / Weight" → { th: "น้ำหนัก", en: "Weight" }: the two halves of an older bilingual label, if it is one. */
export function splitBilingual(text: string): { th: string; en: string } | null {
  const match = /^(.*[\u0E00-\u0E7F].*?)\s+\/\s+([^\u0E00-\u0E7F]*[A-Za-z][^\u0E00-\u0E7F]*)$/.exec(text.trim());
  return match ? { th: match[1].trim(), en: match[2].trim() } : null;
}

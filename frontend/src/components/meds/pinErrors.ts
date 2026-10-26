/** Server error codes of staff PIN approvals (app/staff_pin.py) as TH / EN text. */
const TEXT = {
  en: {
    errors: {
      pin_invalid: "Wrong PIN.", pin_locked: "Too many wrong PINs: locked for 15 minutes.",
      not_authorized_level: "This doctor is below the case owner's level.", no_pin_set: "This doctor has not set a PIN yet.",
      staff_not_found: "Staff code not found.", approval_required: "A doctor's PIN is required.",
    } as Record<string, string>,
  },
  th: {
    errors: {
      pin_invalid: "PIN ไม่ถูกต้อง", pin_locked: "ใส่ PIN ผิดหลายครั้ง ล็อก 15 นาที",
      not_authorized_level: "แพทย์ท่านนี้มีระดับต่ำกว่าแพทย์เจ้าของเคส", no_pin_set: "แพทย์ท่านนี้ยังไม่ได้ตั้ง PIN",
      staff_not_found: "ไม่พบรหัสบุคลากร", approval_required: "ต้องมี PIN ของแพทย์",
    } as Record<string, string>,
  },
};

export function pinErrorText(error: unknown, language: string): string {
  const L = TEXT[language === "th" ? "th" : "en"];
  const message = error instanceof Error ? error.message : String(error);
  return L.errors[message] || message;
}

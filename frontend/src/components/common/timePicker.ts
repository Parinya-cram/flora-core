/**
 * Lets fields made of separate hour and minute boxes open the shared hour/minute grid
 * of DateTimePickerAssist (desktop only; a no-op where the assist is not mounted).
 */
export type TimePickerRequest = {
  anchor: HTMLElement;
  current: { hour: number; minute: number } | null;
  onPick: (hour: number, minute: number) => void;
};

let opener: ((request: TimePickerRequest) => void) | null = null;

export function registerTimePicker(open: ((request: TimePickerRequest) => void) | null) {
  opener = open;
}

export function openTimePicker(anchor: HTMLElement, current: TimePickerRequest["current"], onPick: TimePickerRequest["onPick"]) {
  opener?.({ anchor, current, onPick });
}

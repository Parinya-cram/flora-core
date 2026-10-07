/**
 * Screen input per field type (Phase 1.3 strategy pattern). A new field type needs one entry here, one row
 * in the field type registry and one value validator. Group and repeat are containers rendered by FormRenderer.
 */
import type { ReactElement } from "react";
import type { FieldDefinition } from "../core/types";
import {
  CalculatedOutput, CheckboxInput, FileInput, MultiSelectInput, NumberInput, RadioInput, SelectInput, SignatureInput, SwitchInput, TemporalInput, TextArea, TextInput,
  type InputProps,
} from "./fieldInputs";

export const FIELD_INPUTS: Partial<Record<FieldDefinition["type"], (props: InputProps) => ReactElement>> = {
  text: TextInput, textarea: TextArea, number: NumberInput, decimal: NumberInput, integer: NumberInput,
  date: TemporalInput, datetime: TemporalInput, time: TemporalInput,
  select: SelectInput, radio: RadioInput, multiselect: MultiSelectInput, checkbox: CheckboxInput, switch: SwitchInput,
  file: FileInput, image: FileInput, signature: SignatureInput, calculated: CalculatedOutput,
};

// ─── UI field kinds ───

export type FridaySkillUiFieldKind =
  | "text"
  | "textarea"
  | "number"
  | "toggle"
  | "select"
  | "json"
  | "file";

// ─── UI output widgets ───

export type FridaySkillUiOutputWidget =
  | "text"
  | "json"
  | "table"
  | "keyValue";

// ─── Schema root ───

export interface FridaySkillUiSchemaV1 {
  schemaVersion: "1.0";
  title: string;
  description?: string;
  sections: FridaySkillUiSection[];
  fields: FridaySkillUiField[];
  outputs: FridaySkillUiOutput[];
  actions: FridaySkillUiAction[];
}

// ─── Section ───

export interface FridaySkillUiSection {
  id: string;
  label: string;
  fieldIds: string[];
}

// ─── Field ───

export interface FridaySkillUiField {
  id: string;
  inputKey: string;
  kind: FridaySkillUiFieldKind;
  label: string;
  required: boolean;
  help?: string;
  placeholder?: string;
  defaultValue?: unknown;
  validation?: {
    regex?: string;
    min?: number;
    max?: number;
    enum?: string[];
  };
}

// ─── Output ───

export interface FridaySkillUiOutput {
  id: string;
  outputKey: string;
  label: string;
  widget: FridaySkillUiOutputWidget;
}

// ─── Action ───

export interface FridaySkillUiAction {
  id: "run" | "reset";
  label: string;
  style: "primary" | "secondary";
}

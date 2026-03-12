import { describe, it, expect } from "vitest";

import type {
  FridaySkillUiAction,
  FridaySkillUiField,
  FridaySkillUiFieldKind,
  FridaySkillUiOutput,
  FridaySkillUiOutputWidget,
  FridaySkillUiSchemaV1,
  FridaySkillUiSection,
} from "#skills/generator";

describe("FridaySkillUiSchema types", () => {
  it("FridaySkillUiFieldKind covers all kinds", () => {
    const kinds: FridaySkillUiFieldKind[] = [
      "text",
      "textarea",
      "number",
      "toggle",
      "select",
      "json",
      "file",
    ];
    expect(kinds).toHaveLength(7);
  });

  it("FridaySkillUiOutputWidget covers all widgets", () => {
    const widgets: FridaySkillUiOutputWidget[] = [
      "text",
      "json",
      "table",
      "keyValue",
    ];
    expect(widgets).toHaveLength(4);
  });

  it("FridaySkillUiSection is structurally valid", () => {
    const section: FridaySkillUiSection = {
      id: "main",
      label: "Main Settings",
      fieldIds: ["field-1", "field-2"],
    };
    expect(section.fieldIds).toHaveLength(2);
  });

  it("FridaySkillUiField is structurally valid", () => {
    const field: FridaySkillUiField = {
      id: "name-field",
      inputKey: "name",
      kind: "text",
      label: "Name",
      required: true,
      help: "Enter your name",
      placeholder: "John Doe",
    };
    expect(field.kind).toBe("text");
    expect(field.defaultValue).toBeUndefined();
    expect(field.validation).toBeUndefined();
  });

  it("FridaySkillUiField with validation is structurally valid", () => {
    const field: FridaySkillUiField = {
      id: "count-field",
      inputKey: "count",
      kind: "number",
      label: "Count",
      required: false,
      validation: { min: 1, max: 100 },
    };
    expect(field.validation?.min).toBe(1);
  });

  it("FridaySkillUiOutput is structurally valid", () => {
    const output: FridaySkillUiOutput = {
      id: "result-output",
      outputKey: "result",
      label: "Result",
      widget: "json",
    };
    expect(output.widget).toBe("json");
  });

  it("FridaySkillUiAction is structurally valid", () => {
    const action: FridaySkillUiAction = {
      id: "run",
      label: "Execute",
      style: "primary",
    };
    expect(action.id).toBe("run");
  });

  it("FridaySkillUiSchemaV1 is structurally valid", () => {
    const schema: FridaySkillUiSchemaV1 = {
      schemaVersion: "1.0",
      title: "My Skill",
      description: "A test skill UI",
      sections: [
        { id: "inputs", label: "Inputs", fieldIds: ["f1"] },
      ],
      fields: [
        {
          id: "f1",
          inputKey: "message",
          kind: "textarea",
          label: "Message",
          required: true,
        },
      ],
      outputs: [
        {
          id: "o1",
          outputKey: "response",
          label: "Response",
          widget: "text",
        },
      ],
      actions: [
        { id: "run", label: "Run", style: "primary" },
        { id: "reset", label: "Reset", style: "secondary" },
      ],
    };
    expect(schema.schemaVersion).toBe("1.0");
    expect(schema.sections).toHaveLength(1);
    expect(schema.fields).toHaveLength(1);
    expect(schema.outputs).toHaveLength(1);
    expect(schema.actions).toHaveLength(2);
  });
});

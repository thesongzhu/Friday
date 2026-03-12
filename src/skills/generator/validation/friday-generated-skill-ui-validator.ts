import type { SkillManifestV2 } from "#skills";

import type { FridayGeneratedSkillValidationIssue } from "../model/friday-skill-generator.types.js";
import type { FridaySkillUiSchemaV1 } from "../model/friday-skill-ui-schema.types.js";

// ─── Main UI validation function ───

export function validateUiSchema(
  uiSchema: FridaySkillUiSchemaV1,
  manifest: SkillManifestV2,
): FridayGeneratedSkillValidationIssue[] {
  const issues: FridayGeneratedSkillValidationIssue[] = [];

  // Validate schemaVersion
  if (uiSchema.schemaVersion !== "1.0") {
    issues.push({
      code: "UI_INVALID_SCHEMA_VERSION",
      severity: "error",
      message: `UI schema version must be "1.0", got "${uiSchema.schemaVersion}"`,
    });
  }

  // Validate title
  if (!uiSchema.title || uiSchema.title.trim().length === 0) {
    issues.push({
      code: "UI_MISSING_TITLE",
      severity: "error",
      message: "UI schema must have a non-empty title",
    });
  }

  // Build sets of manifest input and output keys
  const manifestInputKeys = new Set(manifest.inputs.map((i) => i.key));
  const manifestOutputKeys = new Set(manifest.outputs.map((o) => o.key));

  // Validate fields: inputKey must match manifest.inputs
  const fieldIds = new Set<string>();
  for (const field of uiSchema.fields) {
    if (fieldIds.has(field.id)) {
      issues.push({
        code: "UI_DUPLICATE_FIELD_ID",
        severity: "error",
        message: `Duplicate field id: "${field.id}"`,
        path: `fields.${field.id}`,
      });
    }
    fieldIds.add(field.id);

    if (!manifestInputKeys.has(field.inputKey)) {
      issues.push({
        code: "UI_FIELD_INPUT_KEY_MISMATCH",
        severity: "error",
        message: `Field "${field.id}" references inputKey "${field.inputKey}" which does not exist in manifest.inputs`,
        path: `fields.${field.id}.inputKey`,
      });
    }
  }

  // Validate outputs: outputKey must match manifest.outputs
  const outputIds = new Set<string>();
  for (const output of uiSchema.outputs) {
    if (outputIds.has(output.id)) {
      issues.push({
        code: "UI_DUPLICATE_OUTPUT_ID",
        severity: "error",
        message: `Duplicate output id: "${output.id}"`,
        path: `outputs.${output.id}`,
      });
    }
    outputIds.add(output.id);

    if (!manifestOutputKeys.has(output.outputKey)) {
      issues.push({
        code: "UI_OUTPUT_KEY_MISMATCH",
        severity: "error",
        message: `Output "${output.id}" references outputKey "${output.outputKey}" which does not exist in manifest.outputs`,
        path: `outputs.${output.id}.outputKey`,
      });
    }
  }

  // Validate sections: fieldIds must reference existing fields
  const sectionIds = new Set<string>();
  for (const section of uiSchema.sections) {
    if (sectionIds.has(section.id)) {
      issues.push({
        code: "UI_DUPLICATE_SECTION_ID",
        severity: "error",
        message: `Duplicate section id: "${section.id}"`,
        path: `sections.${section.id}`,
      });
    }
    sectionIds.add(section.id);

    for (const fieldId of section.fieldIds) {
      if (!fieldIds.has(fieldId)) {
        issues.push({
          code: "UI_SECTION_REFERENCES_UNKNOWN_FIELD",
          severity: "warning",
          message: `Section "${section.id}" references unknown field id "${fieldId}"`,
          path: `sections.${section.id}.fieldIds`,
        });
      }
    }
  }

  // Validate actions
  if (uiSchema.actions.length === 0) {
    issues.push({
      code: "UI_NO_ACTIONS",
      severity: "warning",
      message: "UI schema has no actions defined",
    });
  }

  return issues;
}

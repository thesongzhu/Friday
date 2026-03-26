import { describe, expect, it } from "vitest";

import {
  getApprovalRequiredReasonForExecCommand,
  getApprovalRequiredReasonForFileMutation,
} from "../../../../src/agent/runtime/friday-agent-tool-risk.js";

describe("friday-agent-tool-risk", () => {
  describe("getApprovalRequiredReasonForExecCommand", () => {
    it("blocks interpreter-style deletion of dump artifacts", () => {
      expect(
        getApprovalRequiredReasonForExecCommand("python delete database.dump"),
      ).toContain("approval");
    });

    it("blocks token mutation commands even when the mutator is generic", () => {
      expect(
        getApprovalRequiredReasonForExecCommand("python apiToken=new-token config.json"),
      ).toContain("token");
    });
  });

  describe("getApprovalRequiredReasonForFileMutation", () => {
    it("blocks dump-like artifact mutation", () => {
      expect(
        getApprovalRequiredReasonForFileMutation("database.dump", ["rotated"]),
      ).toContain("approval");
    });

    it("blocks config writes that assign token-like keys", () => {
      expect(
        getApprovalRequiredReasonForFileMutation("config.json", ['"apiToken": "new-token"']),
      ).toContain("token");
    });
  });
});

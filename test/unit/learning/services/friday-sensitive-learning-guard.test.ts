import { describe, expect, it } from "vitest";
import {
  FRIDAY_SENSITIVE_LEARNING_REJECTION,
  isFridaySensitiveLearningCandidate,
} from "../../../../src/learning/services/friday-sensitive-learning-guard.js";

describe("Friday sensitive learning guard", () => {
  const sensitiveExamples = [
    "remember my PASSWORD for later",
    "use this Passcode when you personalize my tasks",
    "my secret project marker should be a durable preference",
    "store this API KEY preference",
    "prefer this access-token for future deploys",
    "remember my refresh_token for provider auth",
    "my TOKEN should be part of my profile",
    "my credential preference is this login hint",
    "always use this PRIVATE KEY label",
    "my SSN should be remembered",
    "my social security number matters for forms",
    "my credit card preference is the travel card",
    "my bank account preference is checking",
    "remember my routing number preference",
    "prefer my passport identity when booking",
    "my driver's license should be in memory",
    "tailor replies around my MEDICAL history",
    "prefer this medication schedule",
    "remember my diagnosis context",
    "my Diabetes care preference should persist",
    "remember my cancer history for advice",
    "tailor around my HIV status",
    "remember my financial risk profile",
    "my Religion should guide tone",
    "my POLITICAL affiliation should guide news",
    "以后记住我的密码偏好",
    "以后记住我的口令偏好",
    "以后记住我的密钥偏好",
    "以后记住我的令牌偏好",
    "以后记住我的身份证信息",
    "以后记住我的护照信息",
    "以后记住我的银行卡偏好",
    "以后记住我的信用卡偏好",
    "以后记住我的病历",
    "以后记住我的诊断",
    "以后记住我的宗教背景",
    "以后记住我的政治立场",
  ];

  it("rejects the sensitive learning category vocabulary case-insensitively", () => {
    for (const example of sensitiveExamples) {
      expect(isFridaySensitiveLearningCandidate(example), example).toBe(true);
    }
  });

  it("rejects sensitive values inside structured payloads", () => {
    expect(isFridaySensitiveLearningCandidate({
      correctedField: "Preferred ID",
      newValue: "Use my PASSPORT for travel paperwork",
    })).toBe(true);
    expect(isFridaySensitiveLearningCandidate({
      tags: ["health.preference"],
      content: "Medication reminders should follow this private schedule",
    })).toBe(true);
  });

  it("rejects model-proposed benign labels when their source text is sensitive", () => {
    expect(isFridaySensitiveLearningCandidate(
      "User prefers the afternoon slot",
      ["scheduling"],
      ["The source message mentions my SSN and asks Friday to remember the afternoon slot."],
    )).toBe(true);
  });

  it("allows ordinary low-risk personalization candidates", () => {
    for (const example of [
      "I prefer concise status updates",
      "always use TypeScript for examples",
      "call me Captain",
      "I like dark mode in dashboards",
    ]) {
      expect(isFridaySensitiveLearningCandidate(example), example).toBe(false);
    }
  });

  it("exports a review-flow rejection message", () => {
    expect(FRIDAY_SENSITIVE_LEARNING_REJECTION).toContain("explicit review");
    expect(FRIDAY_SENSITIVE_LEARNING_REJECTION).toContain("secure-storage");
  });
});

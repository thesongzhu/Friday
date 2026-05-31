const SENSITIVE_LEARNING_PATTERN =
  /\b(password|passcode|secret|api[\s_-]*key|access[\s_-]*token|refresh[\s_-]*token|token|credential|private[\s_-]*key|ssn|social[\s_]+security|credit[\s_]+card|bank[\s_]+account|routing[\s_]+number|passport|driver'?s[\s_]+license|medical|medication|diagnosis|diabetes|cancer|hiv|financial|religion|political)\b|密码|口令|密钥|令牌|身份证|护照|银行卡|信用卡|病历|诊断|宗教|政治/iu;

export function isFridaySensitiveLearningCandidate(...values: unknown[]): boolean {
  const text = values
    .map((value) => {
      if (typeof value === "string") return value;
      if (value === undefined || value === null) return "";
      try {
        const encoded = JSON.stringify(value);
        return typeof encoded === "string" ? encoded : String(value);
      } catch {
        return String(value);
      }
    })
    .filter((value) => value.length > 0)
    .join(" ");
  return SENSITIVE_LEARNING_PATTERN.test(text);
}

export const FRIDAY_SENSITIVE_LEARNING_REJECTION =
  "Sensitive or high-risk preferences are not persisted automatically. Ask the user to use an explicit review/secure-storage flow instead.";

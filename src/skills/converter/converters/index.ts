import { createFridayAdkSkillConverter } from "./friday-adk-skill-converter.js";
import { createClawdbotSkillMdConverter } from "./friday-clawdbot-skill-md-converter.js";
import { createFridayCodeRepoConverter } from "./friday-code-repo-converter.js";
import { createFridayN8nNodeConverter } from "./friday-n8n-node-converter.js";
import {
  createFridayOpenAiGptActionConverter,
} from "./friday-openai-gpt-action-converter.js";
import { createFridayRecordingConverter } from "./friday-recording-converter.js";
import { createFridayUndocumentedApiConverter } from "./friday-undocumented-api-converter.js";
import { createNativeSkillPackageConverter } from "./friday-native-skill-package-converter.js";

export { createFridayAdkSkillConverter } from "./friday-adk-skill-converter.js";
export { createClawdbotSkillMdConverter } from "./friday-clawdbot-skill-md-converter.js";
export { createNativeSkillPackageConverter } from "./friday-native-skill-package-converter.js";
export { createFridayN8nNodeConverter } from "./friday-n8n-node-converter.js";
export { createFridayOpenAiGptActionConverter } from "./friday-openai-gpt-action-converter.js";
export { createFridayUndocumentedApiConverter } from "./friday-undocumented-api-converter.js";
export { createFridayCodeRepoConverter } from "./friday-code-repo-converter.js";
export { createFridayRecordingConverter } from "./friday-recording-converter.js";

export type { OpenAiGptActionConverterOptions } from "./friday-openai-gpt-action-converter.js";

export const FRIDAY_DEFAULT_CONVERTER_FACTORIES = [
  createNativeSkillPackageConverter,
  createFridayAdkSkillConverter,
  createClawdbotSkillMdConverter,
  createFridayN8nNodeConverter,
  createFridayOpenAiGptActionConverter,
  createFridayCodeRepoConverter,
  createFridayUndocumentedApiConverter,
  createFridayRecordingConverter,
] as const;

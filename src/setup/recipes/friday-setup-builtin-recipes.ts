/**
 * Built-in Setup Recipes — Pre-defined recipes for common configurations.
 *
 * Each recipe describes step-by-step how to configure a service using
 * the autonomous engine (browser automation, desktop control, CLI commands).
 *
 * @module setup/recipes
 */

import type { FridaySetupRecipe } from "../friday-setup.types.js";

// ═══════════════════════════════════════════════════════════════════════
// DISCORD BOT SETUP
// ═══════════════════════════════════════════════════════════════════════

export const DISCORD_BOT_RECIPE: FridaySetupRecipe = {
  id: "channel-discord-bot",
  name: "Discord Bot Setup",
  description: "Create a Discord bot application and configure it to work with Friday.",
  category: "channel",
  version: "1.0.0",
  targetService: "discord",
  prerequisites: [
    {
      type: "network_reachable",
      description: "Discord developer portal must be accessible",
      target: "https://discord.com/developers/applications",
      blocking: true,
    },
  ],
  steps: [
    {
      id: "discord-1",
      index: 0,
      domain: "browser",
      risk: "low",
      instruction: "Navigate to Discord Developer Portal",
      guidance: "Open a browser and navigate to https://discord.com/developers/applications. If not logged in, the user will need to log in to their Discord account first.",
      requiresApproval: false,
      verification: {
        method: "visual",
        expected: "Discord Developer Portal page is visible with 'Applications' heading",
        description: "The browser shows the Discord developer portal",
      },
      maxRetries: 2,
    },
    {
      id: "discord-2",
      index: 1,
      domain: "browser",
      risk: "medium",
      instruction: "Create a new application",
      guidance: "Click the 'New Application' button in the top-right corner. Enter 'Friday Bot' as the application name in the dialog that appears. Accept the terms of service checkbox and click 'Create'.",
      requiresApproval: true,
      verification: {
        method: "visual",
        expected: "Application settings page for 'Friday Bot' is visible",
        description: "A new application has been created",
      },
      maxRetries: 2,
    },
    {
      id: "discord-3",
      index: 2,
      domain: "browser",
      risk: "low",
      instruction: "Navigate to Bot settings",
      guidance: "In the left sidebar, click on 'Bot' to navigate to the bot settings page.",
      requiresApproval: false,
      verification: {
        method: "visual",
        expected: "Bot settings page is visible with 'Build-A-Bot' or token section",
        description: "Bot settings page is displayed",
      },
      maxRetries: 2,
    },
    {
      id: "discord-4",
      index: 3,
      domain: "browser",
      risk: "high",
      instruction: "Reset and copy bot token",
      guidance: "Click 'Reset Token' button to generate a new bot token. Confirm the reset in the dialog. Once the token is displayed, copy it immediately (it will only be shown once). Extract the token value from the page.",
      requiresApproval: true,
      verification: {
        method: "visual",
        expected: "A token string is displayed on the page",
        description: "Bot token has been generated and is visible",
      },
      maxRetries: 1,
      outputKeys: ["botToken"],
    },
    {
      id: "discord-5",
      index: 4,
      domain: "browser",
      risk: "low",
      instruction: "Enable required intents",
      guidance: "Scroll down on the Bot settings page. Enable 'Presence Intent', 'Server Members Intent', and 'Message Content Intent' by toggling each switch on. Click 'Save Changes' at the bottom.",
      requiresApproval: false,
      verification: {
        method: "visual",
        expected: "All three intent toggles are enabled (green/on state)",
        description: "Bot intents are configured",
      },
      maxRetries: 2,
    },
    {
      id: "discord-6",
      index: 5,
      domain: "browser",
      risk: "low",
      instruction: "Generate bot invite URL",
      guidance: "In the left sidebar, click 'OAuth2' → 'URL Generator'. Under 'Scopes', check 'bot'. Under 'Bot Permissions', check 'Send Messages', 'Read Message History', 'View Channels', and 'Embed Links'. Copy the generated URL at the bottom of the page.",
      requiresApproval: false,
      verification: {
        method: "visual",
        expected: "A generated URL is visible at the bottom of the page",
        description: "Invite URL has been generated",
      },
      maxRetries: 2,
      outputKeys: ["inviteUrl"],
    },
  ],
  outputs: [
    { key: "botToken", label: "Discord Bot Token", sensitive: true, configPath: "channels.discord.token" },
    { key: "inviteUrl", label: "Bot Invite URL", sensitive: false },
  ],
  helpUrls: ["https://discord.com/developers/docs/getting-started"],
};

// ═══════════════════════════════════════════════════════════════════════
// TELEGRAM BOT SETUP
// ═══════════════════════════════════════════════════════════════════════

export const TELEGRAM_BOT_RECIPE: FridaySetupRecipe = {
  id: "channel-telegram-bot",
  name: "Telegram Bot Setup",
  description: "Create a Telegram bot via BotFather and configure it for Friday.",
  category: "channel",
  version: "1.0.0",
  targetService: "telegram",
  prerequisites: [
    {
      type: "network_reachable",
      description: "Telegram API must be accessible",
      target: "https://api.telegram.org",
      blocking: true,
    },
  ],
  steps: [
    {
      id: "telegram-1",
      index: 0,
      domain: "browser",
      risk: "low",
      instruction: "Open Telegram Web and navigate to BotFather",
      guidance: "Open a browser and navigate to https://web.telegram.org. If not logged in, the user needs to log in. Then search for '@BotFather' in the chat search and open the conversation.",
      requiresApproval: false,
      verification: {
        method: "visual",
        expected: "BotFather chat is open in Telegram Web",
        description: "BotFather conversation is visible",
      },
      maxRetries: 2,
      alternatives: [
        {
          domain: "desktop",
          instruction: "Open Telegram desktop app and find BotFather",
          guidance: "Launch the Telegram desktop application. Search for '@BotFather' and open the conversation.",
          verification: {
            method: "visual",
            expected: "BotFather chat is open in Telegram desktop",
            description: "BotFather conversation is visible in desktop app",
          },
        },
      ],
    },
    {
      id: "telegram-2",
      index: 1,
      domain: "browser",
      risk: "medium",
      instruction: "Create a new bot",
      guidance: "In the BotFather chat, type and send the message '/newbot'. BotFather will ask for a name — type 'Friday Assistant'. Then BotFather will ask for a username — type 'friday_assistant_bot' (or a unique variation if taken).",
      requiresApproval: true,
      verification: {
        method: "visual",
        expected: "BotFather responds with 'Done! Congratulations' and displays a bot token",
        description: "Bot has been created and token is displayed",
      },
      maxRetries: 2,
      outputKeys: ["botToken"],
    },
  ],
  outputs: [
    { key: "botToken", label: "Telegram Bot Token", sensitive: true, configPath: "channels.telegram.token" },
  ],
  helpUrls: ["https://core.telegram.org/bots/tutorial"],
};

// ═══════════════════════════════════════════════════════════════════════
// SLACK APP SETUP
// ═══════════════════════════════════════════════════════════════════════

export const SLACK_APP_RECIPE: FridaySetupRecipe = {
  id: "channel-slack-app",
  name: "Slack App Setup",
  description: "Create a Slack app with bot capabilities and configure it for Friday.",
  category: "channel",
  version: "1.0.0",
  targetService: "slack",
  prerequisites: [
    {
      type: "network_reachable",
      description: "Slack API must be accessible",
      target: "https://api.slack.com/apps",
      blocking: true,
    },
  ],
  steps: [
    {
      id: "slack-1",
      index: 0,
      domain: "browser",
      risk: "low",
      instruction: "Navigate to Slack App creation page",
      guidance: "Open a browser and navigate to https://api.slack.com/apps. If not logged in, log in to the Slack workspace. Click 'Create New App' and select 'From scratch'. Enter 'Friday' as the app name and select the target workspace.",
      requiresApproval: false,
      verification: {
        method: "visual",
        expected: "Slack app creation dialog or app settings page is visible",
        description: "Slack app management page is accessible",
      },
      maxRetries: 2,
    },
    {
      id: "slack-2",
      index: 1,
      domain: "browser",
      risk: "medium",
      instruction: "Create the Slack app",
      guidance: "Fill in 'Friday' as the app name, select the workspace, and click 'Create App'. You should be redirected to the app's Basic Information page.",
      requiresApproval: true,
      verification: {
        method: "visual",
        expected: "App Basic Information page with 'Friday' as the app name",
        description: "Slack app has been created",
      },
      maxRetries: 2,
    },
    {
      id: "slack-3",
      index: 2,
      domain: "browser",
      risk: "low",
      instruction: "Configure OAuth & Permissions",
      guidance: "In the left sidebar, click 'OAuth & Permissions'. Scroll down to 'Bot Token Scopes' and add the following scopes: chat:write, channels:history, channels:read, groups:history, groups:read, im:history, im:read, mpim:history, mpim:read, users:read.",
      requiresApproval: false,
      verification: {
        method: "visual",
        expected: "Multiple bot token scopes are listed under 'Bot Token Scopes'",
        description: "OAuth scopes have been configured",
      },
      maxRetries: 2,
    },
    {
      id: "slack-4",
      index: 3,
      domain: "browser",
      risk: "medium",
      instruction: "Install app to workspace and get token",
      guidance: "Scroll up on the OAuth & Permissions page and click 'Install to Workspace'. Authorize the app. After installation, copy the 'Bot User OAuth Token' that starts with 'xoxb-'.",
      requiresApproval: true,
      verification: {
        method: "visual",
        expected: "A Bot User OAuth Token starting with 'xoxb-' is displayed",
        description: "App is installed and token is available",
      },
      maxRetries: 1,
      outputKeys: ["botToken"],
    },
    {
      id: "slack-5",
      index: 4,
      domain: "browser",
      risk: "low",
      instruction: "Get App-Level Token for Socket Mode",
      guidance: "Go to 'Basic Information' in the sidebar. Scroll down to 'App-Level Tokens'. Click 'Generate Token and Scopes'. Name it 'friday-socket' and add the scope 'connections:write'. Click 'Generate'. Copy the token that starts with 'xapp-'.",
      requiresApproval: false,
      verification: {
        method: "visual",
        expected: "An app-level token starting with 'xapp-' is displayed",
        description: "App-level token has been generated",
      },
      maxRetries: 2,
      outputKeys: ["appToken"],
    },
    {
      id: "slack-6",
      index: 5,
      domain: "browser",
      risk: "low",
      instruction: "Enable Socket Mode",
      guidance: "In the left sidebar, click 'Socket Mode'. Toggle the switch to enable Socket Mode.",
      requiresApproval: false,
      verification: {
        method: "visual",
        expected: "Socket Mode is enabled (toggle is on)",
        description: "Socket Mode is active",
      },
      maxRetries: 2,
    },
    {
      id: "slack-7",
      index: 6,
      domain: "browser",
      risk: "low",
      instruction: "Enable Events",
      guidance: "In the left sidebar, click 'Event Subscriptions'. Toggle 'Enable Events' on. Under 'Subscribe to bot events', add: message.channels, message.groups, message.im, message.mpim. Click 'Save Changes'.",
      requiresApproval: false,
      verification: {
        method: "visual",
        expected: "Event Subscriptions is enabled with bot events listed",
        description: "Event subscriptions are configured",
      },
      maxRetries: 2,
    },
  ],
  outputs: [
    { key: "botToken", label: "Slack Bot Token (xoxb-)", sensitive: true, configPath: "channels.slack.botToken" },
    { key: "appToken", label: "Slack App Token (xapp-)", sensitive: true, configPath: "channels.slack.appToken" },
  ],
  helpUrls: ["https://api.slack.com/start/quickstart"],
};

// ═══════════════════════════════════════════════════════════════════════
// OPENAI API KEY SETUP
// ═══════════════════════════════════════════════════════════════════════

export const OPENAI_PROVIDER_RECIPE: FridaySetupRecipe = {
  id: "provider-openai",
  name: "OpenAI API Key Setup",
  description: "Get an OpenAI API key and configure it as a Friday LLM provider.",
  category: "provider",
  version: "1.0.0",
  targetService: "openai",
  prerequisites: [
    {
      type: "network_reachable",
      description: "OpenAI must be accessible",
      target: "https://platform.openai.com",
      blocking: true,
    },
  ],
  steps: [
    {
      id: "openai-1",
      index: 0,
      domain: "browser",
      risk: "low",
      instruction: "Navigate to OpenAI API keys page",
      guidance: "Open a browser and navigate to https://platform.openai.com/api-keys. If not logged in, the user will need to log in or create an OpenAI account first.",
      requiresApproval: false,
      verification: {
        method: "visual",
        expected: "OpenAI API keys page is visible",
        description: "API keys management page is accessible",
      },
      maxRetries: 2,
    },
    {
      id: "openai-2",
      index: 1,
      domain: "browser",
      risk: "high",
      instruction: "Create a new API key",
      guidance: "Click '+ Create new secret key'. In the dialog, enter 'Friday' as the key name. Select 'All' permissions. Click 'Create secret key'. Copy the displayed key immediately — it will only be shown once.",
      requiresApproval: true,
      verification: {
        method: "visual",
        expected: "A secret key starting with 'sk-' is displayed in a dialog",
        description: "API key has been created",
      },
      maxRetries: 1,
      outputKeys: ["apiKey"],
    },
  ],
  outputs: [
    { key: "apiKey", label: "OpenAI API Key", sensitive: true, configPath: "providers.openai.apiKey" },
  ],
  helpUrls: ["https://platform.openai.com/docs/quickstart"],
};

// ═══════════════════════════════════════════════════════════════════════
// ANTHROPIC API KEY SETUP
// ═══════════════════════════════════════════════════════════════════════

export const ANTHROPIC_PROVIDER_RECIPE: FridaySetupRecipe = {
  id: "provider-anthropic",
  name: "Anthropic API Key Setup",
  description: "Get an Anthropic API key and configure it as a Friday LLM provider.",
  category: "provider",
  version: "1.0.0",
  targetService: "anthropic",
  prerequisites: [
    {
      type: "network_reachable",
      description: "Anthropic Console must be accessible",
      target: "https://console.anthropic.com",
      blocking: true,
    },
  ],
  steps: [
    {
      id: "anthropic-1",
      index: 0,
      domain: "browser",
      risk: "low",
      instruction: "Navigate to Anthropic Console API keys page",
      guidance: "Open a browser and navigate to https://console.anthropic.com/settings/keys. If not logged in, the user will need to log in or create an Anthropic account first.",
      requiresApproval: false,
      verification: {
        method: "visual",
        expected: "Anthropic Console API keys page is visible",
        description: "API keys page is accessible",
      },
      maxRetries: 2,
    },
    {
      id: "anthropic-2",
      index: 1,
      domain: "browser",
      risk: "high",
      instruction: "Create a new API key",
      guidance: "Click 'Create Key'. Enter 'Friday' as the key name. Click 'Create Key' to confirm. Copy the displayed key immediately — it starts with 'sk-ant-' and will only be shown once.",
      requiresApproval: true,
      verification: {
        method: "visual",
        expected: "A secret key starting with 'sk-ant-' is displayed",
        description: "API key has been created",
      },
      maxRetries: 1,
      outputKeys: ["apiKey"],
    },
  ],
  outputs: [
    { key: "apiKey", label: "Anthropic API Key", sensitive: true, configPath: "providers.anthropic.apiKey" },
  ],
  helpUrls: ["https://docs.anthropic.com/en/docs/getting-started"],
};

export const GOOGLE_PROVIDER_RECIPE = makeProviderApiKeyRecipe({
  id: "provider-google",
  name: "Google AI Studio / Gemini",
  targetService: "google",
  consoleUrl: "https://aistudio.google.com/app/apikey",
  keyHint: "Create a Gemini API key in Google AI Studio and confirm the project has API access enabled.",
  modelHint: "Gemini models are treated as vision-capable only after provider validation or conservative model inference.",
  helpUrls: ["https://ai.google.dev/gemini-api/docs/api-key", "https://ai.google.dev/gemini-api/docs/vision"],
});

function makeProviderApiKeyRecipe(input: {
  id: string;
  name: string;
  targetService: string;
  consoleUrl: string;
  keyHint: string;
  modelHint: string;
  helpUrls: readonly string[];
}): FridaySetupRecipe {
  return {
    id: input.id,
    name: input.name,
    description: `Get an API key for ${input.name} and configure it as a Friday provider.`,
    category: "provider",
    version: "1.0.0",
    targetService: input.targetService,
    prerequisites: [
      {
        type: "network_reachable",
        description: `${input.name} console or docs must be accessible`,
        target: input.consoleUrl,
        blocking: true,
      },
    ],
    steps: [
      {
        id: `${input.targetService}-1`,
        index: 0,
        domain: "browser",
        risk: "low",
        instruction: `Open ${input.name} key or console page`,
        guidance: `Open ${input.consoleUrl}. If not logged in, the user must log in, create an account, complete billing or real-name verification if required, and enable the relevant model/API product.`,
        requiresApproval: false,
        verification: {
          method: "visual",
          expected: `${input.name} console or API key page is visible`,
          description: "Provider setup page is accessible",
        },
        maxRetries: 2,
      },
      {
        id: `${input.targetService}-2`,
        index: 1,
        domain: "browser",
        risk: "high",
        instruction: "Create or reveal an API key",
        guidance: `Create or reveal an API key for Friday. ${input.keyHint} Copy it immediately and keep it secret.`,
        requiresApproval: true,
        verification: {
          method: "visual",
          expected: "A provider API key or access token is visible",
          description: "API key has been created or revealed",
        },
        maxRetries: 1,
        outputKeys: ["apiKey"],
      },
      {
        id: `${input.targetService}-3`,
        index: 2,
        domain: "manual",
        risk: "medium",
        instruction: "Configure provider model and capability in Friday",
        guidance: `Add this provider in Friday Settings. Use the provider's OpenAI-compatible endpoint when available, enter the API key, and add model IDs. ${input.modelHint} Run provider validation and capability doctor before using it.`,
        requiresApproval: true,
        verification: {
          method: "api_call",
          expected: "Friday provider validation returns ok or a precise blocker",
          description: "Provider is saved and validation has run",
        },
        maxRetries: 1,
      },
    ],
    outputs: [
      { key: "apiKey", label: `${input.name} API Key`, sensitive: true, configPath: `providers.${input.targetService}.apiKey` },
    ],
    helpUrls: input.helpUrls,
  };
}

export const VOLCENGINE_PROVIDER_RECIPE = makeProviderApiKeyRecipe({
  id: "provider-volcengine",
  name: "Volcengine ModelArk / Doubao",
  targetService: "volcengine",
  consoleUrl: "https://console.volcengine.com/ark",
  keyHint: "ModelArk may require a dedicated Ark API key and a created endpoint before calls work.",
  modelHint: "Keep text, multimodal, OCR, and speech endpoints separate; declare only the capabilities that pass doctor.",
  helpUrls: ["https://www.volcengine.com/docs/82379", "https://www.volcengine.com/docs/6257/64983"],
});

export const QWEN_PROVIDER_RECIPE = makeProviderApiKeyRecipe({
  id: "provider-qwen",
  name: "Alibaba Cloud Model Studio / Qwen",
  targetService: "qwen",
  consoleUrl: "https://bailian.console.aliyun.com/",
  keyHint: "Use the Model Studio or DashScope API key page for the selected region/workspace.",
  modelHint: "Use text models for text, Qwen-VL models for vision, and embedding models for semantic memory.",
  helpUrls: ["https://www.alibabacloud.com/help/en/model-studio/get-api-key"],
});

export const DEEPSEEK_PROVIDER_RECIPE = makeProviderApiKeyRecipe({
  id: "provider-deepseek",
  name: "DeepSeek API",
  targetService: "deepseek",
  consoleUrl: "https://platform.deepseek.com/api_keys",
  keyHint: "DeepSeek API keys require sufficient API balance before validation succeeds.",
  modelHint: "DeepSeek is treated as text/reasoning unless a custom capability is explicitly configured and verified.",
  helpUrls: ["https://api-docs.deepseek.com/api/deepseek-api"],
});

export const MOONSHOT_PROVIDER_RECIPE = makeProviderApiKeyRecipe({
  id: "provider-moonshot",
  name: "Moonshot / Kimi",
  targetService: "moonshot",
  consoleUrl: "https://platform.moonshot.cn/console/api-keys",
  keyHint: "Create a Moonshot API key and confirm the model IDs enabled for the workspace.",
  modelHint: "Kimi routes are treated as text unless a specific model capability is declared and verified.",
  helpUrls: ["https://platform.moonshot.cn/docs"],
});

export const GLM_PROVIDER_RECIPE = makeProviderApiKeyRecipe({
  id: "provider-glm",
  name: "Zhipu GLM",
  targetService: "glm",
  consoleUrl: "https://bigmodel.cn/usercenter/proj-mgmt/apikeys",
  keyHint: "Create a BigModel API key and confirm model availability for the project.",
  modelHint: "GLM-4V style models can be declared as vision only after doctor verification.",
  helpUrls: ["https://docs.bigmodel.cn/"],
});

export const QIANFAN_PROVIDER_RECIPE = makeProviderApiKeyRecipe({
  id: "provider-qianfan",
  name: "Baidu Qianfan / ERNIE",
  targetService: "qianfan",
  consoleUrl: "https://console.bce.baidu.com/qianfan/ais/console/applicationConsole/application",
  keyHint: "Create or select a Qianfan application and obtain the required API credentials.",
  modelHint: "Treat every non-text capability conservatively until a dedicated probe passes.",
  helpUrls: ["https://cloud.baidu.com/doc/WENXINWORKSHOP/index.html"],
});

export const MINIMAX_PROVIDER_RECIPE = makeProviderApiKeyRecipe({
  id: "provider-minimax",
  name: "MiniMax",
  targetService: "minimax",
  consoleUrl: "https://platform.minimaxi.com/user-center/basic-information/interface-key",
  keyHint: "Create a MiniMax API key and confirm the group/project settings required by the API.",
  modelHint: "Declare TTS or multimodal capabilities only after the corresponding capability doctor passes.",
  helpUrls: ["https://www.minimaxi.com/document"],
});

function makeCapabilityRecipe(input: {
  id: string;
  name: string;
  targetService: string;
  description: string;
  instruction: string;
  guidance: string;
  verificationExpected: string;
  verificationDescription: string;
  helpUrls?: readonly string[];
}): FridaySetupRecipe {
  return {
    id: input.id,
    name: input.name,
    description: input.description,
    category: "integration",
    version: "1.0.0",
    targetService: input.targetService,
    prerequisites: [],
    steps: [
      {
        id: `${input.targetService}-1`,
        index: 0,
        domain: "manual",
        risk: "medium",
        instruction: input.instruction,
        guidance: input.guidance,
        requiresApproval: true,
        verification: {
          method: "api_call",
          expected: input.verificationExpected,
          description: input.verificationDescription,
        },
        maxRetries: 1,
      },
    ],
    outputs: [],
    helpUrls: input.helpUrls,
  };
}

export const TEXT_CAPABILITY_RECIPE = makeCapabilityRecipe({
  id: "capability-text",
  name: "Text Generation Capability Setup",
  targetService: "text",
  description: "Configure and verify a text-generation model route.",
  instruction: "Configure a text provider and run capability doctor",
  guidance: "Add an OpenAI-compatible, Qwen, DeepSeek, Anthropic, Ollama, or CLI text provider. Run provider validation and capability doctor; do not route text tasks to it until text is verified.",
  verificationExpected: "Capability doctor reports text as verified for at least one enabled route.",
  verificationDescription: "Text generation is configured and verified.",
  helpUrls: ["https://platform.openai.com/api-keys", "https://help.aliyun.com/zh/model-studio/get-api-key", "https://api-docs.deepseek.com/"],
});

export const VISION_CAPABILITY_RECIPE = makeCapabilityRecipe({
  id: "capability-vision",
  name: "Vision Capability Setup",
  targetService: "vision",
  description: "Configure and verify image understanding through a multimodal provider.",
  instruction: "Configure a vision-capable provider",
  guidance: "Choose a multimodal model such as Qwen-VL, Gemini, Doubao multimodal, GPT-4o class models, or a verified local vision route. Add the model, run capability doctor with an image probe, and only mark vision available after verification.",
  verificationExpected: "Capability doctor reports vision as verified after a sample image-understanding probe.",
  verificationDescription: "Image understanding is configured and verified.",
  helpUrls: ["https://help.aliyun.com/zh/model-studio/", "https://ai.google.dev/gemini-api/docs", "https://www.volcengine.com/docs/82379"],
});

export const EMBEDDING_CAPABILITY_RECIPE = makeCapabilityRecipe({
  id: "capability-embedding",
  name: "Embedding Capability Setup",
  targetService: "embedding",
  description: "Configure and verify embeddings for semantic memory and search.",
  instruction: "Configure an embedding model",
  guidance: "Add an OpenAI-compatible embedding model such as text-embedding-3-small, or a Qwen/DashScope embedding model. Run capability doctor and verify it returns a vector before enabling semantic memory search.",
  verificationExpected: "Capability doctor reports embedding as verified and returns a non-empty vector.",
  verificationDescription: "Embedding generation is configured and verified.",
  helpUrls: ["https://platform.openai.com/docs/guides/embeddings", "https://help.aliyun.com/zh/model-studio/"],
});

export const OCR_CAPABILITY_RECIPE: FridaySetupRecipe = {
  id: "capability-ocr",
  name: "OCR Capability Setup",
  description: "Configure a verified OCR path through a provider API or an approved local generated tool.",
  category: "integration",
  version: "1.0.0",
  targetService: "ocr",
  prerequisites: [],
  steps: [
    {
      id: "ocr-1",
      index: 0,
      domain: "manual",
      risk: "medium",
      instruction: "Choose an OCR source",
      guidance: "Pick one OCR source: a cloud OCR API such as Volcengine OCR or Google Vision OCR, or an approved local OCR tool generated under tools/generated. Do not mark OCR available until a sample extraction passes.",
      requiresApproval: true,
      verification: {
        method: "api_call",
        expected: "A sample image returns extracted text and the provider/tool is recorded as verified.",
        description: "OCR source is configured and verified.",
      },
      maxRetries: 1,
    },
  ],
  outputs: [],
  helpUrls: ["https://www.volcengine.com/docs", "https://cloud.google.com/vision/docs/ocr"],
};

export const PDF_PARSE_CAPABILITY_RECIPE: FridaySetupRecipe = {
  id: "capability-pdf-parse",
  name: "PDF Parsing Capability Setup",
  description: "Verify Friday's built-in PDF parser for extracting text from PDFs.",
  category: "integration",
  version: "1.0.0",
  targetService: "pdf_parse",
  prerequisites: [],
  steps: [
    {
      id: "pdf-parse-1",
      index: 0,
      domain: "file",
      risk: "low",
      instruction: "Verify the built-in PDF parser on a workspace PDF",
      guidance: "Run the pdf_parse tool against a sample PDF inside the workspace. If the user has not supplied a PDF, ask for one instead of marking verification complete.",
      requiresApproval: false,
      verification: {
        method: "file_content",
        expected: "A sample PDF produces extracted text or structured content.",
        description: "PDF parser is configured and verified.",
      },
      maxRetries: 1,
    },
  ],
  outputs: [],
  helpUrls: ["https://mozilla.github.io/pdf.js/", "https://pypi.org/project/pypdf/"],
};

export const TTS_CAPABILITY_RECIPE: FridaySetupRecipe = {
  id: "capability-tts",
  name: "TTS Capability Setup",
  description: "Configure and verify text-to-speech through an OpenAI-compatible speech provider.",
  category: "integration",
  version: "1.0.0",
  targetService: "tts",
  prerequisites: [],
  steps: [
    {
      id: "tts-1",
      index: 0,
      domain: "manual",
      risk: "high",
      instruction: "Enable a speech model and store its API key",
      guidance: "Configure an OpenAI-compatible provider with a speech model such as gpt-4o-mini-tts, or a compatible MiniMax/Volcengine speech route. Add a runtimeCapabilities declaration for tts and run the capability doctor; do not mark TTS available until a short audio synthesis probe passes.",
      requiresApproval: true,
      verification: {
        method: "api_call",
        expected: "Capability doctor reports tts as verified and the tts tool writes a non-empty audio file.",
        description: "TTS provider is configured and verified.",
      },
      maxRetries: 1,
      outputKeys: ["provider", "apiKey", "model"],
    },
  ],
  outputs: [
    { key: "provider", label: "TTS Provider", sensitive: false, configPath: "tts.provider" },
    { key: "apiKey", label: "TTS API Key", sensitive: true, configPath: "tts.apiKey" },
    { key: "model", label: "TTS Model", sensitive: false, configPath: "tts.model" },
  ],
  helpUrls: [
    "https://platform.openai.com/docs/guides/text-to-speech",
    "https://www.volcengine.com/docs",
    "https://www.minimaxi.com/document",
  ],
};

export const WEB_SEARCH_CAPABILITY_RECIPE: FridaySetupRecipe = {
  id: "capability-web-search",
  name: "Web Search Capability Setup",
  description: "Configure provider-backed web search so Friday can return current results with explicit freshness behavior.",
  category: "integration",
  version: "1.0.0",
  targetService: "web_search",
  prerequisites: [
    {
      type: "network_reachable",
      description: "Serper or Tavily account/API key page must be reachable",
      target: "https://serper.dev/api-key",
      blocking: false,
    },
  ],
  steps: [
    {
      id: "web-search-1",
      index: 0,
      domain: "browser",
      risk: "low",
      instruction: "Choose a web search provider",
      guidance: "Use Serper for Google-style search results or Tavily for research-oriented search. The user may need to create an account, enable billing, and create an API key.",
      requiresApproval: false,
      verification: {
        method: "visual",
        expected: "A Serper or Tavily API key page is visible",
        description: "Search provider console is reachable",
      },
      maxRetries: 2,
    },
    {
      id: "web-search-2",
      index: 1,
      domain: "manual",
      risk: "high",
      instruction: "Store the search API key",
      guidance: "Set FRIDAY_SERPER_API_KEY or FRIDAY_TAVILY_API_KEY in Friday's runtime environment, then restart Friday if the process environment changed.",
      requiresApproval: true,
      verification: {
        method: "api_call",
        expected: "web_search returns results from serper or tavily and reports freshness metadata",
        description: "Provider-backed web search is configured",
      },
      maxRetries: 1,
      outputKeys: ["provider", "apiKey"],
    },
  ],
  outputs: [
    { key: "provider", label: "Search Provider", sensitive: false, configPath: "webSearch.provider" },
    { key: "apiKey", label: "Search API Key", sensitive: true, configPath: "webSearch.apiKey" },
  ],
  helpUrls: ["https://serper.dev/api-key", "https://docs.tavily.com/"],
};

export const BROWSER_CAPABILITY_RECIPE = makeCapabilityRecipe({
  id: "capability-browser",
  name: "Browser Capability Setup",
  targetService: "browser",
  description: "Verify Friday's browser runtime can launch and inspect pages.",
  instruction: "Verify browser runtime",
  guidance: "Run a browser open/status action. Browser is available only after Playwright Chromium or host Chrome launches and returns a page snapshot.",
  verificationExpected: "Browser launch succeeds and snapshot/status returns a live session and tab.",
  verificationDescription: "Browser runtime is verified.",
  helpUrls: ["https://playwright.dev/docs/browsers"],
});

export const MCP_CAPABILITY_RECIPE = makeCapabilityRecipe({
  id: "capability-mcp",
  name: "MCP Capability Setup",
  targetService: "mcp",
  description: "Configure and verify a trusted MCP server.",
  instruction: "Configure an MCP server and run discovery",
  guidance: "Add a reviewed MCP server to FRIDAY_MCP_SERVERS. Run MCP list_tools or discovery; do not mark MCP available until the server reaches loaded state and returns tools/resources/prompts as expected.",
  verificationExpected: "At least one configured MCP server reaches loaded state.",
  verificationDescription: "MCP server is configured and discovered.",
  helpUrls: ["https://modelcontextprotocol.io/"],
});

export const SKILLS_CAPABILITY_RECIPE = makeCapabilityRecipe({
  id: "capability-skills",
  name: "Skills Capability Setup",
  targetService: "skills",
  description: "Install or generate a trusted skill and verify it is discoverable.",
  instruction: "Install or generate a skill",
  guidance: "Install a trusted skill or generate a local skill after approval. Verify its manifest, permissions, and MCP requirements before marking it usable.",
  verificationExpected: "Skill registry lists the installed skill and any MCP requirements are ready.",
  verificationDescription: "Skill runtime is configured and discoverable.",
});

export const CUSTOM_CAPABILITY_RECIPE = makeCapabilityRecipe({
  id: "capability-custom",
  name: "Custom Capability Setup",
  targetService: "custom",
  description: "Generate, install, or connect a custom capability through a tool, skill, provider, or MCP server.",
  instruction: "Define and verify the custom capability",
  guidance: "Clarify the target task, choose the least risky implementation path (built-in tool, generated tool, skill, MCP, or provider declaration), review permissions, then run a representative verification before marking it available.",
  verificationExpected: "A representative task succeeds through the generated/installed/configured capability.",
  verificationDescription: "Custom capability is implemented and verified.",
});

// ═══════════════════════════════════════════════════════════════════════
// NODE.JS INSTALLATION RECIPE
// ═══════════════════════════════════════════════════════════════════════

export const NODE_INSTALL_RECIPE: FridaySetupRecipe = {
  id: "env-node-install",
  name: "Node.js Installation",
  description: "Install Node.js >= 22 on the system.",
  category: "environment",
  version: "1.0.0",
  targetService: "node",
  prerequisites: [
    {
      type: "network_reachable",
      description: "Internet access required",
      target: "https://nodejs.org",
      blocking: true,
    },
  ],
  steps: [
    {
      id: "node-1",
      index: 0,
      domain: "cli",
      risk: "medium",
      instruction: "Install Node.js using the preferred method for this OS",
      guidance: "On macOS: Run 'brew install node@22' if Homebrew is available, otherwise download from https://nodejs.org. On Linux: Use 'curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs'. On Windows: Download the installer from https://nodejs.org.",
      requiresApproval: true,
      verification: {
        method: "cli_output",
        expected: "node --version returns v22 or higher",
        description: "Node.js is installed and version is >= 22",
      },
      maxRetries: 2,
      alternatives: [
        {
          domain: "browser",
          instruction: "Download Node.js installer from the website",
          guidance: "Navigate to https://nodejs.org and download the LTS installer for the current OS. Run the downloaded installer.",
        },
      ],
    },
  ],
  outputs: [],
  helpUrls: ["https://nodejs.org/en/download/"],
};

// ═══════════════════════════════════════════════════════════════════════
// AGGREGATE ALL BUILT-IN RECIPES
// ═══════════════════════════════════════════════════════════════════════

export const FRIDAY_BUILTIN_RECIPES: readonly FridaySetupRecipe[] = [
  DISCORD_BOT_RECIPE,
  TELEGRAM_BOT_RECIPE,
  SLACK_APP_RECIPE,
  OPENAI_PROVIDER_RECIPE,
  ANTHROPIC_PROVIDER_RECIPE,
  GOOGLE_PROVIDER_RECIPE,
  VOLCENGINE_PROVIDER_RECIPE,
  QWEN_PROVIDER_RECIPE,
  DEEPSEEK_PROVIDER_RECIPE,
  MOONSHOT_PROVIDER_RECIPE,
  GLM_PROVIDER_RECIPE,
  QIANFAN_PROVIDER_RECIPE,
  MINIMAX_PROVIDER_RECIPE,
  TEXT_CAPABILITY_RECIPE,
  VISION_CAPABILITY_RECIPE,
  EMBEDDING_CAPABILITY_RECIPE,
  OCR_CAPABILITY_RECIPE,
  PDF_PARSE_CAPABILITY_RECIPE,
  TTS_CAPABILITY_RECIPE,
  WEB_SEARCH_CAPABILITY_RECIPE,
  BROWSER_CAPABILITY_RECIPE,
  MCP_CAPABILITY_RECIPE,
  SKILLS_CAPABILITY_RECIPE,
  CUSTOM_CAPABILITY_RECIPE,
  NODE_INSTALL_RECIPE,
];

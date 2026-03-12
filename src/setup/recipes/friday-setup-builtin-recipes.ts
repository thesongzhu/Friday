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
  NODE_INSTALL_RECIPE,
];

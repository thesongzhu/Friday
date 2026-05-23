#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

const PLATFORM_ORDER = ["macos", "ios", "android", "windows"];

const PLATFORM_DEFAULTS = {
  macos: {
    availability: "release_baseline_target",
    milestone: "macos_beta_release_baseline_target",
    nativeCompanion: "swift_app",
    scaffolds: ["apps/macos/FridayCompanion"],
    notes: [
      "macOS is the first Agent OS release-baseline target, not a completed release claim.",
      "Real signed/notarized artifacts, Sparkle/Homebrew publication evidence, and clean-machine smoke evidence are required before calling the beta baseline release-complete.",
    ],
  },
  ios: {
    availability: "planned",
    milestone: "trusted_device_remote_console_beta",
    nativeCompanion: "ios_remote_console",
    scaffolds: [],
    notes: [
      "iOS is a trusted-device remote console target for this milestone.",
      "TestFlight is the intended beta distribution channel.",
    ],
  },
  android: {
    availability: "planned",
    milestone: "trusted_device_remote_console_beta",
    nativeCompanion: "android_remote_console",
    scaffolds: [],
    notes: [
      "Android is a trusted-device remote console target for this milestone.",
      "Play internal or closed beta is the intended distribution channel.",
    ],
  },
  windows: {
    availability: "scaffolded",
    milestone: "last_mile_desktop_shell",
    nativeCompanion: "dotnet_winui_app",
    scaffolds: ["apps/windows/FridayCompanion", "packaging/winget/templates"],
    notes: [
      "Windows native companion scaffolding exists in-repo.",
      "Windows is the final desktop Agent OS completion track for this milestone.",
    ],
  },
};

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function walk(dirPath) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walk(fullPath));
      continue;
    }
    files.push(fullPath);
  }
  return files;
}

function sortArtifacts(artifacts) {
  return [...artifacts].sort((left, right) =>
    left.fileName.localeCompare(right.fileName, "en", { sensitivity: "base" }));
}

function channelAvailability(channelMetadata, channel, fallback) {
  return channelMetadata[channel]?.availability ?? fallback;
}

function isPublishedChannel(channelMetadata, channel) {
  return channelAvailability(channelMetadata, channel, "planned") === "published";
}

function isReleaseReadyMacosArtifact(artifact) {
  return (
    (artifact.kind === "dmg" || artifact.kind === "zip") &&
    artifact.notarizationStatus === "completed" &&
    ["signed", "notarized"].includes(artifact.signingStatus)
  );
}

async function hasCompleteMacosCleanMachineEvidence(repoRoot) {
  const configuredPath = process.env.FRIDAY_CROSS_PLATFORM_MACOS_EVIDENCE_PATH?.trim();
  const evidencePath = configuredPath
    ? path.resolve(repoRoot, configuredPath)
    : path.join(repoRoot, "docs", "reports", "ops", "cross-platform-agent-os-beta-evidence", "macos-15-clean-machine.md");
  try {
    const evidence = await fs.readFile(evidencePath, "utf8");
    return /^Status:\s*complete\s*$/imu.test(evidence);
  } catch {
    return false;
  }
}

function resolveMacosPlatformStatus(platformArtifacts, channelMetadata, cleanMachineEvidenceComplete) {
  const hasArtifacts = platformArtifacts.length > 0;
  const hasReleaseReadyArtifact = platformArtifacts.some(isReleaseReadyMacosArtifact);
  const hasPublishedSparkle = isPublishedChannel(channelMetadata, "sparkle");
  const hasPublishedHomebrew = isPublishedChannel(channelMetadata, "homebrew");
  const releaseComplete =
    hasReleaseReadyArtifact &&
    hasPublishedSparkle &&
    hasPublishedHomebrew &&
    cleanMachineEvidenceComplete;

  if (releaseComplete) {
    return {
      availability: "shipping_beta_baseline",
      milestone: "macos_signed_notarized_beta_baseline",
      notes: [
        "macOS has signed/notarized artifacts, published Sparkle/Homebrew channels, and complete clean-machine evidence for this beta baseline.",
        "Keep release evidence attached to the tagged release before treating this as a shipped baseline.",
      ],
    };
  }

  if (hasArtifacts) {
    return {
      availability: "local_ci_packaging_baseline",
      milestone: "macos_beta_release_baseline_target",
      notes: [
        "macOS artifacts are local/CI packaging outputs until release credentials, channel publication, and clean-machine smoke are all proven.",
        "DMG/zip presence alone does not prove signed/notarized release readiness.",
      ],
    };
  }

  return {
    availability: PLATFORM_DEFAULTS.macos.availability,
    milestone: PLATFORM_DEFAULTS.macos.milestone,
    notes: PLATFORM_DEFAULTS.macos.notes,
  };
}

function buildChannels({ macosArtifacts, iosArtifacts, androidArtifacts, sourceArtifacts, channelMetadata }) {
  const hasMacosDmg = macosArtifacts.some((artifact) => artifact.kind === "dmg");
  const hasSparkleAppcast = macosArtifacts.some((artifact) => artifact.kind === "appcast" || artifact.kind === "sparkle_appcast");
  const hasIosBeta = iosArtifacts.length > 0;
  const hasAndroidBeta = androidArtifacts.length > 0;

  return {
    githubReleases: {
      availability: channelAvailability(
        channelMetadata,
        "githubReleases",
        macosArtifacts.length > 0 || sourceArtifacts.length > 0 ? "available" : "planned",
      ),
      summary: "Primary release entry for tagged builds and attached install assets.",
    },
    sparkle: {
      availability: channelAvailability(channelMetadata, "sparkle", hasSparkleAppcast ? "generated" : "planned"),
      appcastUrl: channelMetadata.sparkle?.appcastUrl ?? null,
      summary: "Required macOS auto-update channel for the native Agent OS baseline.",
    },
    homebrew: {
      availability: channelAvailability(channelMetadata, "homebrew", hasMacosDmg ? "generated" : "planned"),
      caskTemplatePath: "packaging/homebrew/Casks/friday.rb.template",
      tapRepo: channelMetadata.homebrew?.tapRepo ?? null,
      rawUrl: channelMetadata.homebrew?.rawUrl ?? null,
      summary: "Required macOS install and upgrade channel generated from the DMG metadata.",
    },
    npm: {
      availability: channelAvailability(channelMetadata, "npm", "available"),
      installCommand: "npm install -g @thesongzhu/friday",
      summary: "Scoped npm package fallback while native platform installers remain phased.",
    },
    testflight: {
      availability: channelAvailability(channelMetadata, "testflight", hasIosBeta ? "generated" : "planned"),
      summary: "Intended iOS beta distribution channel for the trusted-device remote console.",
    },
    playInternal: {
      availability: channelAvailability(channelMetadata, "playInternal", hasAndroidBeta ? "generated" : "planned"),
      summary: "Intended Android beta distribution channel for the trusted-device remote console.",
    },
  };
}

function renderMarkdown(manifest) {
  const lines = [
    "# Friday Release Manifest",
    "",
    `- Generated At: \`${manifest.generatedAt}\``,
    `- Version: \`${manifest.version}\``,
    `- Tag: \`${manifest.tag}\``,
    `- Download Base URL: \`${manifest.downloadBaseUrl}\``,
    `- Current Milestone: \`${manifest.currentMilestone}\``,
    "",
    "## Distribution Channels",
    "",
    "| Channel | Availability | Summary |",
    "| --- | --- | --- |",
    ...Object.entries(manifest.channels).map(([channel, payload]) =>
      `| \`${channel}\` | \`${payload.availability}\` | ${payload.summary} |`),
    "",
    "## Platform Status",
    "",
    "| Platform | Availability | Milestone | Native Companion | Artifact Count |",
    "| --- | --- | --- | --- | --- |",
    ...manifest.platforms.map((platform) =>
      `| \`${platform.platform}\` | \`${platform.availability}\` | \`${platform.milestone}\` | \`${platform.nativeCompanion}\` | ${platform.artifacts.length} |`),
    "",
  ];

  for (const platform of manifest.platforms) {
    lines.push(`## ${platform.platform}`);
    lines.push("");
    lines.push(...platform.notes.map((note) => `- ${note}`));
    lines.push("");
    if (platform.artifacts.length === 0) {
      lines.push("- No tagged installer artifacts have been generated for this platform yet.");
      lines.push("");
      continue;
    }
    for (const artifact of platform.artifacts) {
      lines.push(`### ${artifact.displayName}`);
      lines.push("");
      lines.push(`- File: \`${artifact.fileName}\``);
      lines.push(`- Kind: \`${artifact.kind}\``);
      lines.push(`- Arch: \`${artifact.arch}\``);
      lines.push(`- Signing: \`${artifact.signingStatus ?? "unknown"}\``);
      if (artifact.notarizationStatus) {
        lines.push(`- Notarization: \`${artifact.notarizationStatus}\``);
      }
      if (artifact.downloadUrl) {
        lines.push(`- Download URL: \`${artifact.downloadUrl}\``);
      }
      if (artifact.installSummary) {
        lines.push(`- Install: ${artifact.installSummary}`);
      }
      if (artifact.notes?.length) {
        lines.push(...artifact.notes.map((note) => `- ${note}`));
      }
      lines.push("");
    }
  }

  if (manifest.developerFallbacks.length > 0) {
    lines.push("## Developer Fallbacks");
    lines.push("");
    for (const artifact of manifest.developerFallbacks) {
      lines.push(`- \`${artifact.fileName}\` — ${artifact.installSummary ?? "Developer distribution artifact."}`);
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

async function main() {
  const repoRoot = path.resolve(process.env.FRIDAY_RELEASE_REPO_ROOT ?? process.cwd());
  const packageJson = await readJson(path.join(repoRoot, "package.json"));
  const version = String(packageJson.version);
  const tag = process.env.FRIDAY_RELEASE_TAG?.trim() || `v${version}`;
  const downloadBaseUrl = process.env.FRIDAY_RELEASE_DOWNLOAD_BASE_URL?.trim()
    || `https://github.com/thesongzhu/Friday/releases/download/${tag}`;
  const generatedAt = new Date().toISOString();
  const releasesRoot = path.join(repoRoot, "dist", "releases");
  const channelsRoot = path.join(releasesRoot, "channels");

  const artifactFiles = await fileExists(releasesRoot)
    ? (await walk(releasesRoot)).filter((filePath) => filePath.endsWith(".artifact.json"))
    : [];
  const artifacts = await Promise.all(artifactFiles.map((filePath) => readJson(filePath)));
  const channelFiles = await fileExists(channelsRoot)
    ? (await walk(channelsRoot)).filter((filePath) => filePath.endsWith(".json"))
    : [];
  const channelMetadataEntries = await Promise.all(channelFiles.map((filePath) => readJson(filePath)));
  const channelMetadata = Object.fromEntries(
    channelMetadataEntries
      .filter((entry) => typeof entry.channel === "string" && entry.channel.length > 0)
      .map((entry) => [entry.channel, entry]),
  );

  for (const artifact of artifacts) {
    if (!artifact.downloadUrl) {
      artifact.downloadUrl = `${downloadBaseUrl}/${encodeURIComponent(artifact.fileName)}`;
    }
  }

  const sourceArtifacts = sortArtifacts(artifacts.filter((artifact) => artifact.platform === "source"));
  const macosCleanMachineEvidenceComplete = await hasCompleteMacosCleanMachineEvidence(repoRoot);
  const platformEntries = PLATFORM_ORDER.map((platform) => {
    const defaults = PLATFORM_DEFAULTS[platform];
    const platformArtifacts = sortArtifacts(artifacts.filter((artifact) => artifact.platform === platform));
    const macosStatus = platform === "macos"
      ? resolveMacosPlatformStatus(platformArtifacts, channelMetadata, macosCleanMachineEvidenceComplete)
      : null;
    return {
      platform,
      availability: macosStatus?.availability ?? defaults.availability,
      milestone: macosStatus?.milestone ?? defaults.milestone,
      nativeCompanion: defaults.nativeCompanion,
      scaffolds: defaults.scaffolds,
      notes: macosStatus?.notes ?? defaults.notes,
      artifacts: platformArtifacts,
    };
  });

  const manifest = {
    generatedAt,
    version,
    tag,
    downloadBaseUrl,
    currentMilestone: "macos_ios_android_windows_agent_os_rollout",
    longTermVision: "downloadable_cross_platform_ai_automation_employee",
    channels: buildChannels({
      macosArtifacts: platformEntries[0].artifacts,
      iosArtifacts: platformEntries[1].artifacts,
      androidArtifacts: platformEntries[2].artifacts,
      sourceArtifacts,
      channelMetadata,
    }),
    platforms: platformEntries,
    developerFallbacks: sourceArtifacts,
  };

  const outputDir = path.join(releasesRoot);
  const jsonPath = path.join(outputDir, "Friday.release-manifest.json");
  const mdPath = path.join(outputDir, "Friday.release-manifest.md");
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(jsonPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await fs.writeFile(mdPath, renderMarkdown(manifest), "utf8");

  const caskTemplatePath = path.join(repoRoot, "packaging", "homebrew", "Casks", "friday.rb.template");
  if (await fileExists(caskTemplatePath)) {
    const macosDmg = platformEntries[0].artifacts.find((artifact) => artifact.kind === "dmg");
    if (macosDmg) {
      const template = await fs.readFile(caskTemplatePath, "utf8");
      const rendered = template
        .replaceAll("{{VERSION}}", version)
        .replaceAll("{{SHA256}}", macosDmg.sha256)
        .replaceAll("{{URL}}", macosDmg.downloadUrl)
        .replaceAll("{{ARTIFACT_NAME}}", macosDmg.fileName);
      const caskOutputPath = path.join(outputDir, "homebrew", "Casks", "friday.rb");
      await fs.mkdir(path.dirname(caskOutputPath), { recursive: true });
      await fs.writeFile(caskOutputPath, rendered, "utf8");
    }
  }

  process.stdout.write(`${jsonPath}\n`);
}

main().catch((error) => {
  process.stderr.write(`[friday-release-manifest] ${error.message}\n`);
  process.exit(1);
});

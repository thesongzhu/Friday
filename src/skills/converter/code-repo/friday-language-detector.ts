import type {
  FridayCodeRepoLanguageProfile,
  FridayCodeRepoMaterializedSource,
} from "./friday-code-repo.types.js";

const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".kt": "kotlin",
  ".rb": "ruby",
  ".php": "php",
  ".swift": "swift",
  ".sh": "shell",
  ".bash": "shell",
  ".zsh": "shell",
};

export function detectFridayCodeRepoLanguages(
  materialized: FridayCodeRepoMaterializedSource,
): FridayCodeRepoLanguageProfile[] {
  const counts = new Map<string, number>();

  for (const file of materialized.files) {
    const language = detectLanguageFromFileName(file.relativePath);
    if (!language) continue;
    counts.set(language, (counts.get(language) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([language, fileCount]) => ({ language, fileCount }))
    .sort((a, b) => b.fileCount - a.fileCount);
}

function detectLanguageFromFileName(relativePath: string): string | null {
  const slash = Math.max(relativePath.lastIndexOf("/"), relativePath.lastIndexOf("\\"));
  const fileName = slash === -1 ? relativePath : relativePath.slice(slash + 1);

  if (fileName === "Dockerfile") return "docker";
  if (fileName === "Makefile") return "make";

  const dot = fileName.lastIndexOf(".");
  if (dot === -1) return null;

  const ext = fileName.slice(dot).toLowerCase();
  return EXTENSION_TO_LANGUAGE[ext] ?? null;
}


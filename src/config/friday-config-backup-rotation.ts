import * as fs from "node:fs/promises";

/** Rotates config backups in descending order: `.bak.(n-1)` -> `.bak.n`, `.bak` -> `.bak.1`. */
export async function rotateFridayConfigBackups(
  configPath: string,
  maxBackups: number,
): Promise<void> {
  if (maxBackups <= 1) return;

  // Check if original config file exists
  try {
    await fs.access(configPath);
  } catch (err) {
    console.warn("[friday][config-backup-rotation] config file not accessible:", err instanceof Error ? err.message : String(err));
    return; // Nothing to back up
  }

  // Drop the oldest backup if it exists
  try {
    await fs.unlink(`${configPath}.bak.${maxBackups - 1}`);
  } catch (err) {
    // Doesn't exist, fine
    console.warn("[friday][config-backup-rotation] oldest backup removal skipped:", err instanceof Error ? err.message : String(err));
  }

  // Rotate existing numbered backups downward: .bak.i -> .bak.(i+1)
  for (let i = maxBackups - 2; i >= 1; i--) {
    const src = `${configPath}.bak.${i}`;
    const dest = `${configPath}.bak.${i + 1}`;
    try {
      await fs.rename(src, dest);
    } catch (err) {
      // Source doesn't exist, skip
      console.warn("[friday][config-backup-rotation] backup rotation skipped:", err instanceof Error ? err.message : String(err));
    }
  }

  // Rotate .bak -> .bak.1
  try {
    await fs.rename(`${configPath}.bak`, `${configPath}.bak.1`);
  } catch (err) {
    // .bak doesn't exist, skip
    console.warn("[friday][config-backup-rotation] bak rename skipped:", err instanceof Error ? err.message : String(err));
  }

  // Copy current config to .bak
  await fs.copyFile(configPath, `${configPath}.bak`);
}

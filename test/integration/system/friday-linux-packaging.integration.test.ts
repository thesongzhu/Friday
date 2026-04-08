import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");

describe("Linux packaging artifacts", () => {
  describe("Debian packaging", () => {
    const debDir = resolve(REPO_ROOT, "packaging/linux/deb/DEBIAN");

    it("control file exists and has required fields", () => {
      const controlPath = resolve(debDir, "control");
      expect(existsSync(controlPath)).toBe(true);
      const content = readFileSync(controlPath, "utf8");
      expect(content).toContain("Package:");
      expect(content).toContain("Version:");
      expect(content).toContain("Architecture:");
      expect(content).toContain("Description:");
    });

    it("postinst script exists and is executable-ready", () => {
      const postinstPath = resolve(debDir, "postinst");
      expect(existsSync(postinstPath)).toBe(true);
      const content = readFileSync(postinstPath, "utf8");
      expect(content).toContain("#!/");
    });

    it("prerm script exists and cleans up symlink", () => {
      const prermPath = resolve(debDir, "prerm");
      expect(existsSync(prermPath)).toBe(true);
      const content = readFileSync(prermPath, "utf8");
      expect(content).toContain("#!/");
    });
  });

  describe("AppImage packaging", () => {
    const appimageDir = resolve(REPO_ROOT, "packaging/linux/appimage");

    it("AppRun exists and is executable-ready", () => {
      const appRunPath = resolve(appimageDir, "AppRun");
      expect(existsSync(appRunPath)).toBe(true);
      const content = readFileSync(appRunPath, "utf8");
      expect(content).toContain("#!/");
    });

    it("desktop file exists with required fields", () => {
      const desktopPath = resolve(appimageDir, "friday.desktop");
      expect(existsSync(desktopPath)).toBe(true);
      const content = readFileSync(desktopPath, "utf8");
      expect(content).toContain("[Desktop Entry]");
      expect(content).toContain("Name=");
      expect(content).toContain("Exec=");
      expect(content).toContain("Type=Application");
    });
  });

  describe("Build script", () => {
    it("build-friday-linux-packages.sh exists", () => {
      const scriptPath = resolve(REPO_ROOT, "scripts/ops/build-friday-linux-packages.sh");
      expect(existsSync(scriptPath)).toBe(true);
      const content = readFileSync(scriptPath, "utf8");
      expect(content).toContain("#!/");
      expect(content).toContain("dpkg-deb");
    });
  });
});

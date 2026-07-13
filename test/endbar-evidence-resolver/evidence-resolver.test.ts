/**
 * Negative-control matrix + positive test for the ENDBAR evidence-reference
 * resolver (GOV-EVIDENCE-REFERENCE-RESOLUTION-001, P0).
 *
 * Each attack asserts a SPECIFIC typed rejection class — never a bare
 * `toThrow()`. Against the naive baseline these fail behaviorally (the resolver
 * returns content / follows the symlink / recurses); against the hardened
 * resolver they all reject and the positive tests pass.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EvidenceHashMismatchError,
  EvidencePathEscapeError,
  EvidenceReferenceCycleError,
  EvidenceSelectorAmbiguousError,
  EvidenceSelectorDanglingError,
  EvidenceSymlinkRejectedError,
  resolveEvidence,
} from "../../tools/endbar-evidence-resolver/index.js";
import type { EvidenceManifest } from "../../tools/endbar-evidence-resolver/index.js";

function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

const ZERO_HASH = "0".repeat(64);

let workspace: string;
let root: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "endbar-evidence-"));
  root = join(workspace, "root");
  mkdirSync(root, { recursive: true });
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe("evidence resolver — positive", () => {
  it("resolves a valid selector to the verified bytes", () => {
    const content = "hello-evidence-artifact";
    writeFileSync(join(root, "good.txt"), content);
    const manifest: EvidenceManifest = {
      root,
      entries: [
        { type: "doc", id: "a", path: "good.txt", sha256: sha256Hex(content) },
      ],
    };

    const resolved = resolveEvidence(manifest, { type: "doc", id: "a" });

    expect(resolved.bytes.toString("utf8")).toBe(content);
    expect(resolved.sha256).toBe(sha256Hex(content));
    expect(resolved.realPath).toBe(join(root, "good.txt"));
  });

  it("follows a valid (acyclic) alias chain to the terminal artifact", () => {
    const content = "aliased-artifact";
    writeFileSync(join(root, "target.txt"), content);
    const manifest: EvidenceManifest = {
      root,
      entries: [
        { type: "alias", id: "top", ref: { type: "doc", id: "real" } },
        {
          type: "doc",
          id: "real",
          path: "target.txt",
          sha256: sha256Hex(content),
        },
      ],
    };

    const resolved = resolveEvidence(manifest, { type: "alias", id: "top" });

    expect(resolved.bytes.toString("utf8")).toBe(content);
    expect(resolved.selector).toEqual({ type: "doc", id: "real" });
  });
});

describe("evidence resolver — hardening controls", () => {
  it("EVIDENCE_PATH_ESCAPE: rejects a relative path that escapes root", () => {
    const secret = "outside-secret"; // pragma: allowlist secret
    writeFileSync(join(workspace, "escape.txt"), secret);
    const manifest: EvidenceManifest = {
      root,
      entries: [
        {
          type: "doc",
          id: "esc",
          path: "../escape.txt",
          sha256: sha256Hex(secret),
        },
      ],
    };

    expect(() =>
      resolveEvidence(manifest, { type: "doc", id: "esc" }),
    ).toThrow(EvidencePathEscapeError);
  });

  it("EVIDENCE_PATH_ESCAPE: rejects an absolute path outside root", () => {
    const secret = "abs-outside-secret"; // pragma: allowlist secret
    const absOutside = join(workspace, "abs.txt");
    writeFileSync(absOutside, secret);
    const manifest: EvidenceManifest = {
      root,
      entries: [
        { type: "doc", id: "abs", path: absOutside, sha256: sha256Hex(secret) },
      ],
    };

    expect(() =>
      resolveEvidence(manifest, { type: "doc", id: "abs" }),
    ).toThrow(EvidencePathEscapeError);
  });

  it("EVIDENCE_SYMLINK_REJECTED: rejects a symlink component pointing outside root", () => {
    const secret = "symlink-target-secret"; // pragma: allowlist secret
    const outsideTarget = join(workspace, "secret.txt");
    writeFileSync(outsideTarget, secret);
    symlinkSync(outsideTarget, join(root, "link.txt"));
    const manifest: EvidenceManifest = {
      root,
      // sha256 == the target's real hash, so ONLY the symlink guard can reject.
      entries: [
        {
          type: "doc",
          id: "sym",
          path: "link.txt",
          sha256: sha256Hex(secret),
        },
      ],
    };

    expect(() =>
      resolveEvidence(manifest, { type: "doc", id: "sym" }),
    ).toThrow(EvidenceSymlinkRejectedError);
  });

  it("EVIDENCE_HASH_MISMATCH: rejects when file bytes differ from manifest hash", () => {
    writeFileSync(join(root, "tampered.txt"), "actual-on-disk-bytes");
    const manifest: EvidenceManifest = {
      root,
      entries: [
        {
          type: "doc",
          id: "stale",
          path: "tampered.txt",
          // Expected hash of DIFFERENT content — stale/tampered manifest.
          sha256: sha256Hex("what-the-manifest-expected"),
        },
      ],
    };

    expect(() =>
      resolveEvidence(manifest, { type: "doc", id: "stale" }),
    ).toThrow(EvidenceHashMismatchError);
  });

  it("EVIDENCE_SELECTOR_AMBIGUOUS: rejects a selector matching duplicate ids", () => {
    writeFileSync(join(root, "one.txt"), "one");
    writeFileSync(join(root, "two.txt"), "two");
    const manifest: EvidenceManifest = {
      root,
      entries: [
        { type: "doc", id: "dup", path: "one.txt", sha256: sha256Hex("one") },
        { type: "doc", id: "dup", path: "two.txt", sha256: sha256Hex("two") },
      ],
    };

    expect(() =>
      resolveEvidence(manifest, { type: "doc", id: "dup" }),
    ).toThrow(EvidenceSelectorAmbiguousError);
  });

  it("EVIDENCE_SELECTOR_DANGLING: rejects a selector with no matching entry", () => {
    writeFileSync(join(root, "present.txt"), "present");
    const manifest: EvidenceManifest = {
      root,
      entries: [
        {
          type: "doc",
          id: "present",
          path: "present.txt",
          sha256: sha256Hex("present"),
        },
      ],
    };

    expect(() =>
      resolveEvidence(manifest, { type: "doc", id: "missing" }),
    ).toThrow(EvidenceSelectorDanglingError);
  });

  it("EVIDENCE_REFERENCE_CYCLE: rejects a cyclic alias chain (A→B→A)", () => {
    const manifest: EvidenceManifest = {
      root,
      entries: [
        { type: "alias", id: "A", ref: { type: "alias", id: "B" } },
        { type: "alias", id: "B", ref: { type: "alias", id: "A" } },
      ],
    };

    expect(() =>
      resolveEvidence(manifest, { type: "alias", id: "A" }),
    ).toThrow(EvidenceReferenceCycleError);
  });

  it("EVIDENCE_HASH_MISMATCH: an all-zero manifest hash never matches real bytes", () => {
    writeFileSync(join(root, "z.txt"), "non-empty");
    const manifest: EvidenceManifest = {
      root,
      entries: [{ type: "doc", id: "z", path: "z.txt", sha256: ZERO_HASH }],
    };

    expect(() =>
      resolveEvidence(manifest, { type: "doc", id: "z" }),
    ).toThrow(EvidenceHashMismatchError);
  });
});

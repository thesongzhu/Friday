#!/usr/bin/env node
/**
 * friday-stress-authority-review.mjs
 *
 * TEST-STRESS-AUTHORITY-ADAPTER-001 (R13 EXHAUSTIVE-STRESS) — the SEPARATELY
 * EXECUTED independent review step (F3 fix). It is a DISTINCT command, run under
 * a DISTINCT reviewer identity, that INDEPENDENTLY recomputes and checks a
 * generated subject-inventory bundle and, only if the checks hold, emits
 * content-addressed review statements bound to the EXACT tuple + generator +
 * subject set. The authority adapter refuses to mark any authority PASS without
 * one of these statements.
 *
 * HONESTY BOUNDARY: this demonstrates the review MACHINERY and role separation.
 * It is NOT a trusted external CI principal or human signer — genuine external
 * trust (a real reviewer/CI identity, an operator signature) is deferred. A real
 * run without such an identity therefore stays UNSEALED.
 *
 * The reviewer must NOT be the producer: `--reviewer-id` must differ from the
 * bundle's `producer_id`, else the review is refused (exit 4).
 *
 * Exit: 0 = statements emitted; 3 = the bundle failed an independent recompute
 * check (review REFUSED); 4 = reviewer identity is invalid / equals producer.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const canonical = (value) =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : value && typeof value === "object"
      ? `{${Object.keys(value)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
          .join(",")}}`
      : JSON.stringify(value);
const digestOf = (value) => sha(Buffer.from(canonical(value)));

const REVIEW_SCHEMA = "friday.stress.authority-review.r13.v1";

function parseArgs(argv) {
  const args = { bundleDir: null, reviewerId: null, outDir: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--bundle-dir") args.bundleDir = argv[(i += 1)];
    else if (argv[i] === "--reviewer-id") args.reviewerId = argv[(i += 1)];
    else if (argv[i] === "--out-dir") args.outDir = argv[(i += 1)];
  }
  return args;
}

export function reviewBundle({ bundleDir, reviewerId }) {
  const inv = JSON.parse(fs.readFileSync(path.join(bundleDir, "FRIDAY_STRESS_SUBJECT_INVENTORY.json")));
  const producerId = inv.producer_id;
  if (typeof reviewerId !== "string" || !reviewerId) return { ok: false, exit: 4, code: "REVIEWER_ID_INVALID" };
  if (reviewerId === producerId) return { ok: false, exit: 4, code: "REVIEWER_EQUALS_PRODUCER", detail: { producerId } };

  // INDEPENDENT recompute: the tuple and subject-set digests must reproduce from
  // the emitted document (the reviewer does not trust the emitted digests).
  const tuple = digestOf(inv.final_release_candidate_components);
  if (tuple !== inv.final_release_candidate_tuple_sha256) return { ok: false, exit: 3, code: "TUPLE_RECOMPUTE_MISMATCH" };
  const sortedSubjects = [...inv.subjects].sort((a, b) => a.subject_id.localeCompare(b.subject_id));
  const subjectSetSha = digestOf(sortedSubjects);
  if (subjectSetSha !== inv.subject_set_sha256) return { ok: false, exit: 3, code: "SUBJECT_SET_RECOMPUTE_MISMATCH" };
  if (inv.unknown_ids.length || inv.ghost_ids.length) return { ok: false, exit: 3, code: "RECONCILIATION_NONZERO" };

  // Bind one review statement per authority, to the EXACT subject_ids the
  // producer claims for that kind (re-read from the producer's raw attestation).
  const statements = [];
  for (const ref of inv.authority_inputs) {
    const bytes = fs.readFileSync(path.join(bundleDir, ref.path));
    if (sha(bytes) !== ref.sha256) return { ok: false, exit: 3, code: "AUTHORITY_REF_DRIFT", detail: { path: ref.path } };
    const att = JSON.parse(bytes);
    if (att.final_release_candidate_tuple_sha256 !== tuple || att.producer_id !== producerId) {
      return { ok: false, exit: 3, code: "AUTHORITY_BINDING_MISMATCH", detail: { kind: att.source_kind } };
    }
    for (const id of att.subject_ids) {
      if (!sortedSubjects.some((s) => s.subject_id === id)) {
        return { ok: false, exit: 3, code: "AUTHORITY_GHOST_SUBJECT", detail: { kind: att.source_kind, id } };
      }
    }
    statements.push({
      schema_version: REVIEW_SCHEMA,
      reviewer_id: reviewerId,
      producer_id: producerId,
      reviewed_generator_sha256: att.generator_sha256,
      reviewed_final_release_candidate_tuple_sha256: tuple,
      reviewed_subject_set_sha256: subjectSetSha,
      source_kind: att.source_kind,
      reviewed_subject_ids_sha256: digestOf([...att.subject_ids].sort()),
      verdict: "PASS",
    });
  }
  return { ok: true, exit: 0, statements, producerId, tuple };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const fail = (exit, code, detail = {}) => {
    console.error(JSON.stringify({ result: "REVIEW_REFUSED", code, detail }));
    process.exit(exit);
  };
  if (!args.bundleDir) return fail(3, "MISSING_BUNDLE_DIR");
  if (!args.reviewerId) return fail(4, "MISSING_REVIEWER_ID");
  let res;
  try {
    res = reviewBundle({ bundleDir: path.resolve(args.bundleDir), reviewerId: args.reviewerId });
  } catch (error) {
    return fail(3, "REVIEW_UNEXPECTED", { detail: String(error) });
  }
  if (!res.ok) return fail(res.exit, res.code, res.detail || {});
  const outDir = args.outDir ? path.resolve(args.outDir) : null;
  if (outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    for (const stmt of res.statements) {
      const content = `${JSON.stringify(stmt, null, 2)}\n`;
      fs.writeFileSync(path.join(outDir, `review-${stmt.source_kind}-${sha(Buffer.from(content))}.json`), content);
    }
  }
  console.log(JSON.stringify({ result: "REVIEWED_PASS", reviewer_id: args.reviewerId, producer_id: res.producerId, statements: res.statements.length, out_dir: outDir }));
  process.exit(0);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main();

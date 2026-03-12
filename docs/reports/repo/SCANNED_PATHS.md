> Status: Historical report. This file is retained for audit and evidence; if it conflicts with current behavior, prefer [`docs/current-source-of-truth.md`](../../current-source-of-truth.md).

# Scanned Paths

Date: 2026-03-04 (America/Los_Angeles)

## Scan Method

Primary inventory source:

```bash
cd .
git ls-files > /tmp/friday_all_tracked_files.txt
```

This avoids sampling bias and covers every tracked file in the repository at scan time.

## Top-Level Coverage

Tracked top-level paths scanned:

1. `src/`
2. `test/`
3. `ui/`
4. `scripts/`
5. `docs/`
6. `examples/`
7. `managed-skills/`
8. `.github/`
9. `reports/`
10. root config/build/docs files (`package.json`, `tsconfig.json`, `vitest.config.ts`, `Dockerfile`, `docker-compose.yml`, `.env.example`, `.gitignore`, etc.)

Requested-but-absent top-level paths (not present in this repo):

1. `packages/`
2. `apps/`
3. `server/`
4. `client/`
5. `tools/`
6. `infra/`

## Exclusion Rules

No tracked files existed under:

1. `node_modules/`
2. `dist/`
3. `.git/`
4. `.friday/`

Reason:

1. `node_modules/` and `dist/` are generated/runtime artifacts and not authoritative source.
2. `.git/` is VCS metadata.
3. `.friday/` is local runtime state/cache.

These directories were still included in hygiene checks for accidental commits.

## File Count Statistics

Evidence commands:

```bash
wc -l /tmp/friday_all_tracked_files.txt
awk -F/ '{print $1}' /tmp/friday_all_tracked_files.txt | sort | uniq -c | sort -nr
awk 'BEGIN{FS="/"} {f=$NF; if(f ~ /\./){ext=f; sub(/^.*\./,"",ext)} else {ext="(no_ext)"}; print ext}' /tmp/friday_all_tracked_files.txt | sort | uniq -c | sort -nr
```

Results:

1. Total tracked files: `1900`
2. Source-code files (`ts|tsx|js|mjs|cjs|sh|css|html`): `1626`
3. Config files (`json|yml|yaml|cfg|Dockerfile|tsconfig|eslint/vitest config|gitignore`): `73`

Top extension distribution:

1. `ts`: 1477
2. `md`: 179
3. `tsx`: 106
4. `json`: 60
5. `sh`: 29
6. `mjs`: 10
7. `yml`: 7
8. `csv`: 7
9. `png`: 6
10. `(no_ext)`: 4
11. `txt`: 3
12. `yaml`: 1
13. `snap`: 1
14. `js`: 1
15. `html`: 1
16. `css`: 1
17. `cjs`: 1

Top path distribution:

1. `src`: 848
2. `test`: 578
3. `docs`: 161
4. `ui`: 155
5. `managed-skills`: 76
6. `scripts`: 20
7. `reports`: 13
8. `examples`: 8
9. `.github`: 7

## Statement of Coverage

This scan was full-file inventory over all tracked files, not a sample subset.

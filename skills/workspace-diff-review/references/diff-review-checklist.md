# Workspace Diff Review Checklist

## Risk Assessment

- [ ] Changes to auth, payments, or data-deletion paths flagged as high-risk
- [ ] Database migration is reversible or has a rollback plan
- [ ] Config changes (env, feature flags) documented
- [ ] Breaking API changes have a migration path

## Correctness

- [ ] New branches/conditions have matching test coverage
- [ ] Removed code is truly unreachable (no hidden callers)
- [ ] Renamed symbols updated in all references
- [ ] Default values are safe if new fields are absent

## Landing Safety

- [ ] CI passes on the current diff
- [ ] No unintended file changes (lock files, generated code)
- [ ] Merge conflicts resolved correctly
- [ ] Feature flag guards anything not ready for all users

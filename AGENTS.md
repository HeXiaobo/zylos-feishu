# Feishu repository agent policy

This repository is the Feishu communication component. These rules apply to
every agent working in this repository and complement the workspace-level
Zylos governance policy.

## Roles and branch boundaries

- A feature agent works on one issue in one worktree. Feature branches
  (`feat/*`, `fix/*`, `chore/*`, `docs/*`, `refactor/*`, `test/*`, `codex/*`,
  `wip/*`, and similar branches) must not bump the package release version,
  edit a frozen release manifest, create a release, deploy, or run a
  production canary.
- A review agent may inspect, test, and comment. It may not change a frozen
  release SHA or deploy.
- Only an explicitly authorized release manager may change a release version,
  prepare a release candidate, or update the frozen external manifest. Only an
  explicitly authorized deploy operator may deploy.
- A version label is not an immutable release identity. Name a release by its
  repository, package version, and complete 40-character commit SHA.

## Required task start

Before changing files, report or record:

```text
repo: zylos-feishu
branch: <branch>
head: <complete 40-character SHA>
version: <package.json version>
tests: <planned or not run>
```

Run the local metadata and branch gate from the repository root:

```sh
npm run governance:check -- --base origin/main
```

Use a separate worktree for concurrent work and preserve unrelated changes.

## Release and deployment gates

- Release and deploy commands accept only a complete 40-character commit SHA
  from an external release manifest. They must never resolve a branch, tag,
  short SHA, `latest`, or a mutable package label.
- Release/deploy mode must be given `--manifest PATH` or
  `ZYLOS_RELEASE_MANIFEST`; the manifest must be a valid
  `zylos.release-manifest/v1`, target this repository and exact HEAD, have
  `status: READY`, and set `deploymentAllowed: true`.
- Do not store a manifest in this repository that contains the SHA of the
  commit that creates or edits that manifest. This would be a self-reference;
  keep the release manifest in the external workspace control plane.
- A feature branch that changes any release version relative to its base is a
  hard failure. Keep `package.json`, `package-lock.json`, `capabilities.json`,
  and the SKILL frontmatter aligned at all times.
- Passing a check authorizes no deployment by itself. Dry-run, backup,
  provenance, compatibility, canary, rollback, and post-deploy verification
  remain required by the workspace runbook.
- Before stopping a service or writing to an employee runtime, run a fresh
  identity probe and verify that the target Agent name, `profileId`, and
  hostname match the intended runtime. Never trust an `--agent` argument as
  proof of identity; a mismatch is `HOLD` before any service stop or write.

## Required task finish

The final handoff must include the actual values (use `UNKNOWN` when not
verified):

```text
repo: zylos-feishu
branch: <branch>
head: <complete 40-character SHA>
version: <package.json version>
tests: <commands and results>
manifest/release: <external path and release ID, or N/A>
deployment: <not run / details>
identity probe: <name/profileId/hostname match, or N/A>
```

Do not claim a release, merge, push, deployment, or canary unless it was
directly verified.

## Repository-linked upgrades

An explicit request to upgrade this repository selects `--only feishu` in the
shared Core preparation tool. Read UPGRADE.md. Fetching the shared tools does not
authorize upgrading Core or the other communication component. Preserve their
verified installed versions and full SHAs, verify compatibility and unchanged
source/configuration, and use the scoped native updater after the deployment
gate. Only an explicit request for the complete bundle selects `--only all`.
Routine preparation is the Agent's responsibility, not an extra owner approval.

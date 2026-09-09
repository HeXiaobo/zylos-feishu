# Upgrade zylos-feishu from one repository link

Ask the resident Agent to upgrade this component to latest or a specific version,
using https://github.com/HeXiaobo/zylos-feishu. No separate ZIP, Markdown attachment,
or owner-written ledger is needed.

## Scope

An upgrade request for this repository means **only feishu**. Keep the other two
components at their verified installed repository/version/full commit SHA.
Do not broaden the upgrade if compatibility fails; report the required companion
version and leave the other components unchanged. An explicit request for all
three components may use the shared all-component workflow.

## Agent entrypoint

Read the [shared Core upgrade procedure](https://github.com/HeXiaobo/zylos-core/blob/main/UPGRADE.md)
and obtain its `tools/upgrade` directory in an isolated checkout of the Core
repository. This fetches operator tools; it does **not** install or upgrade Core.
Record the tool commit and read the nearest AGENTS.md.

Collect the actual host's verified component source baseline into a local
`installed.json` yourself, then prepare with:

```sh
node tools/upgrade/prepare.mjs --only feishu --feishu latest --installed /absolute/installed.json --out /absolute/new/control-directory --authorization-ref OWNER_MESSAGE_ID
```

For a named version, replace latest with that exact version (for example 0.3.7-rc.20).
The paths and message reference are filled by the Agent, not the owner.
Continue with the generated WORKFLOW.md. Use `command.mjs` to obtain just the
selected component's native update command after the existing deployment gate.
Do not run a full Core/Feishu pair installation for this single-component request.

Verify compatibility with the installed companions, identity, backup, source,
communications and data. Compare the unselected components' source, versions and
configuration before and after. Report the selected component, preserved
components, execution ID and actual result. Installation alone is not acceptance.

An explicit owner upgrade request covers routine preparation, the selected
upgrade, normal service restarts, verification and supported rollback. A link
alone is not authorization. Preserve accounts, runtime provider and business
data. Ask once only for genuinely missing permissions/login, required human test
input or previously unauthorized deletion. Do not invent PASS evidence.

## Deletion prediction contract

During the rc.9→rc.10 upgrade an ad-hoc worst-case tree diff predicted DELETE
for 459 files under `references/`; the real reify deleted 0 files and left the
tree byte-identical (issue #44). Any deletion prediction produced for this
component must follow these rules:

- The authoritative prediction is the fork-pair summary's `reifyPlans`
  (`zylos.component-reify-plan/v1`): `certainty: "exact"` means execute reifies
  the same plan; `certainty: "conservative"` (a post-upgrade hook runs after
  the merge and may recreate, remove, or rewrite files) is an estimate and must
  be reported as one.
- The real reify deletes only files that are **tracked by the installed
  baseline manifest**, **removed upstream**, and **locally unmodified**. A
  locally modified tracked file is preserved (backed up, reported as
  preserved). Files untracked by the baseline — for example the hook-installed
  `references/` lark skills and the `references/.lark-cli-version` pin — are
  never deleted by the upgrade sync; the component's post-upgrade hook manages
  that content idempotently.
- Any other enumeration (for example "present in the live tree, absent from
  the target tree") is a worst-case estimate. It must be labeled
  `predicted (worst-case)` in every output, must never be presented as the
  deterministic upgrade result, and must not by itself drive preserve/delete
  decisions.
- Use `node scripts/upgrade-delete-prediction.mjs --live <installedDir>
  --target <newSourceDir> [--backup-dir <dir>] [--apply] [--json]` for an
  ad-hoc deletion analysis: it computes the prediction and, with `--apply`,
  reifies the same shared plan, so the predicted delete set and the actually
  deleted set cannot drift apart, and it labels the untracked worst-case class
  explicitly.

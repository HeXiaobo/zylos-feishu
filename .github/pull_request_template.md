## Task role and scope

- Role: `feature` / `review` / `release-manager` / `deploy`
- Issue/task: <!-- link or N/A -->
- Base full SHA: <!-- 40 hexadecimal characters -->
- Head full SHA: <!-- 40 hexadecimal characters -->
- Package version: <!-- package.json version -->
- Release metadata changed: `No` (required for feature PRs) / `Yes`

## Validation

- Tests: <!-- commands and results -->
- Manifest/release ID: <!-- external manifest path + ID, or N/A -->
- Deployment impact: `None — not deployed` / <!-- describe approved impact -->
- Runtime identity probe: <!-- Agent name/profileId/hostname match, or N/A -->

Feature PRs must state that no release version was bumped and no deployment or
production canary was run.

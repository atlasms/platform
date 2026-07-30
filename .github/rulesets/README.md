# Branch rulesets

## Status: written, **not applied** — blocked on a GitHub plan, not on engineering

[`main.json`](main.json) is the ruleset that enforces the branch policy from
[the working agreement](../../docs/roadmap/20-delivery-process.md#87-repos--branching):
PR required, CI green before merge, no force-push, no deletion.

Applying it currently fails:

```
$ gh api -X POST repos/atlasms/platform/rulesets --input .github/rulesets/main.json
Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)
```

**Both** classic branch protection and the newer rulesets require a paid plan
(Pro / Team / Enterprise) on **private** repositories. `atlasms/platform` is private, and should
stay private — it is a commercial product, so "make it public" is not the workaround.

## What this means in the meantime

CI still runs on every PR and a failure is **visible** on the PR — it just is not **blocking**.
Nothing stops a red PR being merged except discipline. Until the plan is upgraded, the
[Definition of Done](../../docs/roadmap/20-delivery-process.md#7-definition-of-done) is a
convention, not a gate.

This is the single highest-value thing to unblock: it is what converts the DoD from _something
someone remembers_ into something enforced. It matters more as the team grows past one person, and
much more once AI-assisted changes are landing frequently.

## Applying it (one command, once the org is on Team)

```bash
gh api -X POST repos/atlasms/platform/rulesets \
  --input .github/rulesets/main.json

# verify
gh api repos/atlasms/platform/rulesets --jq '.[] | {id, name, enforcement}'
```

To update an existing ruleset, `PUT` to `repos/atlasms/platform/rulesets/<id>` with the same file.

## What it enforces

| Rule                     | Effect                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------- |
| `pull_request`           | No direct pushes to `main`; stale reviews dismissed on push; review threads must be resolved      |
| `required_status_checks` | **`lint · typecheck · test`** must pass, and the branch must be up to date with `main` (`strict`) |
| `non_fast_forward`       | No force-pushing `main`                                                                           |
| `deletion`               | `main` cannot be deleted                                                                          |

**`required_approving_review_count` is `0`**, deliberately. The doc calls for ≥1, but the team is
currently one person and GitHub does not let you approve your own PR — a count of 1 would block
every merge. **Raise this to 1 (and 2 for [correctness-critical paths](../CODEOWNERS)) as soon as
there is a second engineer.**

**Repository admins can bypass** (`bypass_actors`), so a solo maintainer cannot lock themselves out
of their own repository during an incident. Remove that entry once the team is large enough that
the escape hatch costs more than it saves.

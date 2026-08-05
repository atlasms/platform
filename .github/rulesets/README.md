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
(Pro / Team / Enterprise) on **private** repositories.

GitHub's error names the two ways out, and only one of them is acceptable:

- **Make the repository public** — this genuinely works, and it is the wrong trade. `docs/` is the
  complete product architecture, which is the actual work; code is replicable, the design is not.
  Public is also effectively irreversible: you can switch back, but anything cloned, forked or
  archived while public is gone. (Worth knowing the exposure is only IP: the history holds no keys,
  no `.env`, no tokens, and the credential-shaped strings in it are dev values that authenticate to
  nothing but a local kind cluster.)
- **One paid seat** — GitHub Team is the smallest real fix, and the one to take when a second
  person joins. That is also when protection starts earning its price.

## What this means in the meantime

CI still runs on every PR and a failure is **visible** — it just is not **blocking**. Nothing stops
a red PR being merged except discipline, so the
[Definition of Done](../../docs/roadmap/20-delivery-process.md#7-definition-of-done) is a
convention rather than a gate.

The gap is smaller than it first looks. Branch protection mainly protects a team **from each
other**: required review, CI green before somebody else's merge, no force-push over a colleague's
work. With one committer the failure it actually prevents is pushing something broken — so
[`.githooks/pre-push`](../../.githooks/pre-push) closes most of it, locally and for free:

```bash
git config core.hooksPath .githooks     # enable (already set in this working copy)
```

It runs `lint typecheck test` before any push and refuses on failure. **It is not equivalent** — a
server-side rule cannot be skipped and this one can (`git push --no-verify`) — but a bypass is
deliberate and visible rather than accidental.

Upgrading remains the highest-value thing to unblock, and it matters much more as the team grows
past one person, or once AI-assisted changes land frequently.

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

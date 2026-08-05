# Branch rulesets

## Status: **applied and enforcing** (ruleset `20478500`)

[`main.json`](main.json) enforces the branch policy from
[the working agreement](../../docs/roadmap/20-delivery-process.md#87-repos--branching):
PR required, CI green before merge, no force-push, no deletion.

It was blocked for months on a GitHub plan — both classic branch protection and rulesets require
Pro/Team/Enterprise on a **private** repository. The repository is now **public**, which is the
other way GitHub's own error offers, and the ruleset applied immediately.

```bash
gh api -X POST repos/atlasms/platform/rulesets --input .github/rulesets/main.json
gh api -X PUT  repos/atlasms/platform/rulesets/20478500 --input .github/rulesets/main.json   # update
gh api repos/atlasms/platform/rulesets --jq '.[] | {id, name, enforcement}'                  # verify
```

## The bypass that made it do nothing

The first version carried `bypass_actors: [{ RepositoryRole 2 (admin), bypass_mode: always }]`, on
the reasoning that a solo maintainer must not lock themselves out during an incident.

**That reasoning was wrong, and it made the ruleset ornamental.** The only committer is an admin, so
a standing bypass meant the rule applied to nobody. A direct push to `main` was accepted with the
ruleset active. The escape hatch it was protecting is also redundant: an admin can always edit or
disable the ruleset itself, so the ability to recover during an incident never depended on the
bypass. It has been removed, and `main` now refuses a direct push from everyone:

```
remote: - Changes must be made through a pull request.
remote: - Required status check "lint · typecheck · test" is expected.
 ! [remote rejected] main -> main (push declined due to repository rule violations)
```

> **`git push --dry-run` cannot verify this.** GitHub evaluates rulesets on the actual receive, so a
> dry-run reports success whether or not the rule would refuse. It is a rule-check that always
> passes, which is worse than no check. Probe with a real push of an empty commit and reset after.

## What it enforces

| Rule                     | Effect                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------- |
| `pull_request`           | No direct pushes to `main`; stale reviews dismissed on push; review threads must be resolved      |
| `required_status_checks` | **`lint · typecheck · test`** must pass, and the branch must be up to date with `main` (`strict`) |
| `non_fast_forward`       | No force-pushing `main`                                                                           |
| `deletion`               | `main` cannot be deleted                                                                          |

**`required_approving_review_count` is `0`**, deliberately. The doc calls for ≥1, but the team is
one person and GitHub does not let you approve your own PR — a count of 1 would block every merge.
**Raise it to 1 (and 2 for [correctness-critical paths](../CODEOWNERS)) as soon as there is a second
engineer**, at which point `require_code_owner_review` should go on too.

## The local hook is still worth keeping

[`.githooks/pre-push`](../../.githooks/pre-push) runs the same checks before a push leaves the
machine. The ruleset makes it non-essential, not redundant: it fails in ~1 minute locally instead of
after a push, a PR and a CI run, and it applies to every branch rather than only `main`.

```bash
git config core.hooksPath .githooks
```

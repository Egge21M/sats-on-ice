# Issue tracker: GitHub

Issues and specs live in https://github.com/Egge21M/sats-on-ice/issues. Use the `gh` CLI for tracker operations.

## Conventions

Run commands from this repository so `gh` infers the repository from `origin`. When running elsewhere, add `--repo Egge21M/sats-on-ice`.

- **Create**: `gh issue create --title "..." --body-file <path>`.
- **Read**: `gh issue view <number> --json number,title,body,labels,comments`.
- **List**: `gh issue list --state open --json number,title,body,labels,comments`, with appropriate `--label` and `--state` filters.
- **Comment**: `gh issue comment <number> --body-file <path>`.
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`.
- **Close**: `gh issue close <number> --comment "..."`.

For multiline bodies and comments, write the exact text to a temporary file and pass it with `--body-file`. Use `triage-labels.md` for triage label strings.

## Pull requests as a triage surface

**PRs as a request surface: no.**

GitHub shares issue and pull request numbers. For an ambiguous reference, resolve its type with `gh pr view <number>`, falling back to `gh issue view <number>`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Read the issue body, labels, and comments using the read command above.

## Wayfinding operations

Used by `/wayfinder`. The map is one issue with child issues as tickets.

- **Map**: an issue labelled `wayfinder:map`, holding Notes, Decisions-so-far, and Fog.
- **Child ticket**: link it to the map as a GitHub sub-issue through `gh api`. If sub-issues are unavailable, add it to a task list in the map and put `Part of #<map>` at the top of the child. Label the child `wayfinder:<type>` (`research`, `prototype`, `grilling`, or `task`).
- **Blocking**: use native issue dependencies. Add a blocker with `gh api --method POST repos/Egge21M/sats-on-ice/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`. Obtain the database ID with `gh api repos/Egge21M/sats-on-ice/issues/<blocker> --jq .id`. If dependencies are unavailable, use a `Blocked by: #<number>, #<number>` line at the top of the child. A ticket is unblocked when all blockers are closed.
- **Frontier**: inspect the map's open children, excluding assigned tickets and tickets with open blockers. Use `issue_dependencies_summary.blocked_by` or resolve the fallback references to check blockers. Choose the first remaining ticket in map order.
- **Claim**: assign the ticket with `gh issue edit <number> --add-assignee @me` before working on it.
- **Resolve**: comment with the answer, close the ticket, and append a summary and link to Decisions-so-far in the map issue.

# Domain Docs

This repository uses a single-context layout: `CONTEXT.md` at the repository root and architecture decision records under `docs/adr/`.

## Before exploring

- Read root `CONTEXT.md` for domain terms and boundaries.
- Read ADRs in `docs/adr/` that touch the area being explored.

If these documents do not exist, proceed silently without proposing placeholders. The `/domain-modeling` skill creates them lazily when terms or decisions are resolved.

## Use the glossary's vocabulary

When naming domain concepts in issues, proposals, hypotheses, and tests, use the terms defined in `CONTEXT.md`. If a needed concept is missing, reconsider invented terminology or note a real glossary gap for `/domain-modeling`.

## Flag ADR conflicts

If a proposal contradicts an existing ADR, identify the ADR and explain why the decision should be reopened before proceeding.

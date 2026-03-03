# AGENTS.md

## Purpose

This document defines how agents should work in this repository: ship reliable code quickly, keep solutions simple, and preserve a strong product design standard.

## Core Engineering Principles

- **KISS (Keep It Simple, Stupid):** Prefer the simplest solution that fully solves the problem.
- **DRY (Don’t Repeat Yourself):** Avoid duplicated logic. Centralize shared behavior behind clear abstractions.
- **YAGNI (You Aren’t Gonna Need It):** Do not add features, complexity, or abstractions before they are required.

## Development Workflow

- ALWAYS start new work on a dedicated Git worktree.
- Keep one branch per worktree and one purpose per branch.
- Make small, focused commits.
- Commit often, but only commit code that builds, runs, and works.
- Before committing: run relevant checks/tests and verify no obvious regressions.

### Worktree Quickstart

```bash
git fetch origin
git worktree add ../desktop-v2-<feature> -b <feature-branch> origin/main
cd ../desktop-v2-<feature>
```

## Code Quality Standards

- Prioritize readability over cleverness.
- Use clear naming and explicit control flow.
- Keep functions and components focused on a single responsibility.
- Add comments only where intent is non-obvious.
- Refactor opportunistically when touching messy code, but keep scope controlled.

## Design Style Expectations

- Design should feel intentional, consistent, and high-signal.
- Maintain visual hierarchy with clear typography, spacing, and contrast.
- Avoid generic, template-like UI decisions when a stronger product choice is possible.
- Preserve consistency with established product patterns unless there is a clear reason to evolve them.
- Favor polished interactions: predictable states, meaningful feedback, and smooth transitions.

## Scope and Decision Rules

- Solve the user’s actual request, not adjacent “maybe useful” ideas.
- If tradeoffs exist, choose the option that is easier to maintain.
- Document important constraints and assumptions in PRs/commits.

## Git Hygiene

- Keep commits atomic and message them clearly.
- Rebase/squash only when it improves review clarity.
- Never mix unrelated changes in the same commit.
- Leave the tree cleaner than you found it.

# Agent rules for frumo

Read README.md first. Work on a branch and open a pull request; never push to main.

## Merging and safety files

- Agents push and open pull requests as the GitHub account `nanocarrica`, never as MarianoCarrica.
- Merging is not deploying. Once the required checks (`lint`, `typecheck`, `test`) are green, an ordinary pull request merges itself (squash, auto-merge); no human review. frumo has no deploy target; adding one, or releasing/publishing anything, needs Mariano's explicit go-ahead.
- A pull request that touches any path in `.github/CODEOWNERS` needs Mariano's approval on GitHub (the `main-gate` ruleset requires a code-owner review). Keep such changes in their own small pull request and say so in its description. Before asking for approval, bring it up to date with main and switch on auto-merge; never push to it after he approves.
- Never edit `.github/CODEOWNERS`, the CI job ids, or the ruleset to get around this.
- Never change the CI job ids `lint`, `typecheck`, `test`; the package.json must provide `lint`, `typecheck` and `test` scripts.

## Fix mistakes in code, not in instructions

Repeated corrections become a check (lint rule, type, test), not prose. Fix failing checks at the root cause; never suppress or skip them. Features come with verification proof in the PR: test output, and screenshots for UI.

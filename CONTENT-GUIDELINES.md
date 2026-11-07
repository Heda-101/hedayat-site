# Content guidelines

## Confidentiality rule

- Employers by name are fine (PwC, IFS, SFU, Digital Democracies Institute). Nothing confidential beneath them.
- No internal tool names. Refer to the in-house framework only as "an in-house agent framework at a global consultancy". This doc follows the same rule, since it goes public with the repo.
- No client names, logos or screenshots. At most "a major North American utility".
- Client-work results stay qualitative unless Hedayat clears a specific number.
- Applies to commits, PR descriptions and any AI chat logs shown, not only to pages.

## What the guard checks

1. Deterministic layer: git pre-commit and pre-push hooks run a gitleaks secret scan, a blocked-terms scan of contents, commit messages and branch names, and stop any push that adds an image file.
2. AI layer: before any agent push, a separate confidentiality review reads the diff against the rule above.
3. Bypass prevention: `--no-verify` is denied for agents, a Claude Code hook runs the same checks on agent pushes, and GitHub push protection is the final backstop.

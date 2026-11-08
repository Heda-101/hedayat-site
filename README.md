# hedayat-site

The personal website of Hedayat Tabesh: a scroll-driven home page that walks through his method in five chapters, plus an Experience page with his CV. This repository is public, so everything committed here is subject to the rules in `CONTENT-GUIDELINES.md`.

## Requirements

- Node 22, installed with nvm (`nvm install 22`).
- gitleaks 8.19 or newer (`brew install gitleaks`).
- For agent pushes: the `claude` CLI on your PATH and signed in.
- A blocked-terms file at `~/.config/hedayat-site/blocked-terms.txt`. Without it, every commit and push is blocked. One term per line. Lines starting with `#` are comments. A plain line matches anywhere, ignoring case, spaces and punctuation, so write multi-word names as plain lines. A line starting with `word:` matches only as a whole word.
- CI needs the blocked terms in an Actions secret named `BLOCKED_TERMS`, in the same format.

## Setup

After cloning, run `bash scripts/setup.sh`. It turns on the git hooks and checks the requirements above.

Run `npm run test:guard` for the guard's unit tests and `npm run guard:selftest` for an end-to-end check.

## How the guard works

- Layer 1, git hooks: every commit and push is checked for secrets (gitleaks) and blocked terms, and a new image in a push needs a human to confirm it.
- Layer 2, AI review: a push made from an agent's shell also gets an AI review against `CONTENT-GUIDELINES.md`, run in the pre-push hook.
- Layer 3, Claude Code hooks: agents cannot skip or change the git hooks, push anything but their current branch, or put blocked terms in PR or issue text, and edits to guard files need a human to approve them.
- CI: the same secret and blocked-term scans run on every pull request and on pushes to `main`.

Agents should run `git push` with a long Bash timeout (600000 ms), because the pre-push AI review can take a few minutes.

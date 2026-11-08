# hedayattabesh.com — Phase 1 Design

Date: 2026-10-26 · Owner: Hedayat Tabesh · Status: draft for review

## 1. Intent

A personal site that sells Hedayat as an **AI Solution Architect** who designs and builds to a high standard of delivery. The audience is prospective employers and clients; they should leave with a "wow" and a clear sense of how Hedayat works.

The core idea: **the site is its own proof.** The home page is a scroll story through five delivery phases (Plan → Design → Build → Test → Deliver). Each phase states a standard Hedayat follows and shows the real records of applying it *to this site*: its design doc, design system, pull requests, test results and releases. The site was built largely by AI agents under Hedayat's direction and quality gates, and says so openly; that is the job he is pitching for.

Hedayat is moving from field service / utilities work toward AI work. The site must position him as an architect, with field ops as background, not identity.

## 2. Goals

- An opening screen that says who he is and what he does within five seconds: name, "AI Solution Architect", one-line promise. No field-ops jargon.
- A keynote-style scroll story (big type, pinned chapters, numbers counting up, smooth motion) through the five phases.
- Every number on the home page is either produced by the site's own pipeline or explicitly marked as sample. No typed-in claims at launch.
- An Experience page that is fast to scan, grouped by skill (AI delivery first), with a by-date toggle.
- Each standard links to where Hedayat learned it on the Experience page ("learned on").
- The repo is public from day one, so the site is visibly built in public under its own standards. Its history is part of the proof.

## 3. Non-goals (phase 1)

- Client case studies woven into the phases (phase 2).
- Project tabs with "fun" interactive pages (phase 2). The nav shows "Projects · soon".
- The "ask my CV" AI assistant (phase 2). Phase 1 choices must not block it.
- Blog, CMS, contact form backend, multi-language.

## 4. Anti-goals (would be failure even if it works)

- Animation that stutters, janks on mobile, or ignores reduced-motion. A flashy site that performs badly disproves the pitch.
- Reads as "web developer" or "field ops specialist" rather than AI Solution Architect.
- Any NDA leak: a client name, internal tool name, screenshot or unapproved figure, anywhere in the site **or the git history**.
- Stats that can drift from reality, or sample numbers that reach launch unmarked.
- A public history of "test" commits and pushes straight to main.

## 5. Constraints

**Confidentiality rule** (also to live in the repo as content guidelines):
- Employers by name are fine (PwC, IFS, SFU, Digital Democracies Institute). Nothing confidential beneath them.
- No internal tool names. Refer to the in-house framework only as "an in-house agent framework at a global consultancy". This doc follows the same rule, since it goes public with the repo.
- No client names, logos or screenshots. At most "a major North American utility".
- Client-work results stay qualitative unless Hedayat clears a specific number.
- Applies to commits, PR descriptions and any AI chat logs shown, not only to pages.

**Accounts (Hedayat's call):** the repo is owned by Hedayat's personal GitHub account. A separate machine account for the AI agents is signed in on the laptop (git and `gh`), added as a collaborator with write access only, using a token scoped to this repo. Commits in this repo use the machine account's identity through repo-local git config, so other repos are untouched. Hedayat reviews and approves pull requests from his own account in a separate browser profile. Main requires one approval from someone other than the author, so every merge records a human approval. Both accounts use two-factor authentication.

**Repo hygiene from the first commit:** no secrets ever; protected main (free, since the repo is public); changes arrive by pull request with passing checks.

**Pre-push safety net (Hedayat's call).** A public repo publishes every pushed branch immediately, so PR review cannot be the safety net. These checks run on the laptop before anything leaves it:
1. *Deterministic layer* (git pre-commit and pre-push hooks, covering every commit in the push range):
   - gitleaks secret scan.
   - A blocked-terms scan over file contents, commit messages and branch names. The list lives **outside the repo** (`~/.config/hedayat-site/blocked-terms.txt`), is written by Hedayat himself, and is never committed or shared in chat. Failures report file and line, never the matched term.
   - Any push that adds an image file stops for Hedayat's explicit confirmation.
2. *AI layer:* before any agent push, a separate confidentiality review reads the diff against the confidentiality rule, to catch identifying paraphrases the term list cannot.
3. *Bypass prevention:* the agent setup denies `--no-verify`, and a Claude Code hook runs the same checks on any agent `git push`. GitHub push protection for secrets is the final backstop.

Accepted residual risk: Hedayat bypassing the hooks himself (web editor, another machine), and anything neither the term list nor the AI review recognises.

**Accessibility and motion:** every animation has a reduced-motion equivalent; content is readable without JavaScript-driven reveals (nothing stuck at opacity 0).

## 6. Approaches considered

Build order (the stack is decided separately, §7):

| | Approach | Trade-off |
|---|---|---|
| A | Thin slice first: pipeline + one chapter end to end, then the rest | Proves live stats early; site looks unfinished longer |
| **B** | **Design first: full design system + mockups + motion prototype, then build** | See the whole look early; pipeline proven later |
| C | Build pages, add checks at the end | Fastest visual result; contradicts the site's own claim |

**Chosen: B (Hedayat's call).** To limit its main risk, the first build PR sets up the full pipeline (checks, stats file, deploy) before any chapter is built. Design work is also committed via PRs so the Design chapter has a real record.

## 7. Decisions

### Stack (approved from the stack report, 26 Oct 2026)

| Area | Decision |
|---|---|
| Framework | Astro + TypeScript |
| Scroll animation | GSAP + ScrollTrigger, reduced-motion fallbacks |
| Styling | CSS custom-property design tokens + Astro scoped CSS (no Tailwind) |
| Hosting | Cloudflare (Pages/Workers), PR preview deploys |
| Domain | hedayattabesh.com via Cloudflare Registrar. WHOIS showed it unregistered on 26 Oct 2026; register before the pipeline PR. Fallback: htabesh.dev |
| Repo | GitHub, public from day one (free plan), protected main, PR-only, pre-push safety net (§5) + CI secret scanning (gitleaks) + GitHub push protection |
| Quality checks | GitHub Actions: type check, Vitest, Playwright + axe, Lighthouse CI on built output, gitleaks |
| Live numbers | Pipeline writes `stats.json` published beside the site; page fetches it at load and shows run date + link to run; designed fallback if it fails |
| Uptime / analytics | Cloudflare Web Analytics (cookieless, no banner) + an external free uptime monitor (terms to confirm) |
| CV content | One typed data file (YAML/JSON via Astro content collections) → Experience page + downloadable PDF + "learned on" targets; build fails on a broken "learned on" reference |

### Claude skills for the build
GSAP official skills, Emil Kowalski motion skills (incl. `review-animations`, `animation-performance`), Impeccable (installed as a plugin, not via npx). Install after this doc is approved.

### Site structure
- **Home ("Method")**: opening screen, then five pinned chapters, then a closing call to action (contact + link to Experience).
- **Experience**: grouped by skill (AI delivery → Architecture & delivery → Data & platforms), by-date toggle, career timeline. "Learned on" links land on and highlight a specific entry (anchor per entry).
- **Nav** on every page: Method · Experience · Projects (soon). Experience is always one click away, for recruiters who skip the story.
- **Side progress rail** on the home page showing the five phases and the current one (hidden on narrow screens).

### Chapter anatomy (same four parts in every chapter)
1. Headline (pins while the chapter scrolls).
2. The standard, in one sentence, framed so it transfers beyond websites.
3. Live evidence from this site, each item showing where it came from.
4. "Learned on" line linking to an Experience entry, described generically.

### Chapter content

| Phase | Standard (draft wording) | Evidence from this site | Learned on (generic) |
|---|---|---|---|
| Plan | No build starts without written, agreed requirements. | This design doc and its decisions log, rendered from the repo | Requirements workshops on enterprise implementations |
| Design | Systems are designed before they're built; interfaces are agreed first. | Live design tokens (colour, type, spacing, motion) and the design PR history | Integration contracts between two enterprise platforms |
| Build | AI writes, people own what merges. | Stack + architecture diagram; PR count, review stats, commit history links | Agent orchestration turning wireframes into system configuration |
| Test | Nothing ships on an AI's word alone. | Performance score, accessibility violations, tests passing, PRs reviewed, all from `stats.json` | Test cycles run through milestone sign-off |
| Deliver | Releases are small, frequent and reversible. | Release count, last release date, uptime from external monitor, time to fix | Remote go-lives with few issues |

Wording of standards is a draft; Hedayat edits the final copy.

### Positioning and copy
- Opening line (draft): "AI Solution Architect · Vancouver" / "Designed to ship. Built to standard." / "This site is the proof."
- Openly states the site was built largely by AI agents under Hedayat's standards and review.
- Experience page leads with AI work: agent orchestration (wireframes → system configuration), documentation standards for an in-house agent framework, custom agents, LLM upskilling for teams, and the ML classifier (80% accuracy on unseen data). Field-ops roles are described by the problem solved, not product names.

### Visual direction (early)
Keynote style: dark ground, very large condensed display type, one accent colour, monospaced labels for data and provenance. See `docs/design/mockups/early-mockups.html` (three frames: opening screen, Test chapter, Experience page). Sample data is visibly marked (amber "Sample numbers" label). The full design phase replaces these mockups.

### CV content source
The source is Hedayat's 2026 résumé plus the AI work described during planning: the wireframes-to-configuration agent orchestration, the agent framework documentation, custom agents, and LLM upskilling for teams. The only cleared figure is the classifier's 80% accuracy on unseen data, which is non-client research work. Every other client-work result stays qualitative until Hedayat clears it.

### Deliver metrics (definitions, builder's call recorded)
- **Release:** every production deploy from main. The pipeline tags each one automatically (`release-YYYYMMDD-N`) and writes a changelog entry from merged PR titles.
- **Time to fix:** median open-to-close time of GitHub issues labelled `incident`. Shows "no incidents yet" until one exists.
- **Uptime:** from the external monitor's API, over the last 30 days.

### AI chat logs
Not shown in phase 1. If the Plan or Build chapter later quotes agent conversations, they are short, hand-picked excerpts, reviewed against the confidentiality rule before merge.

### Sample data
All sample numbers live in one clearly named fixture and render with a visible "sample" marker. A launch check fails the build if any sample data is still in use.

## 8. Milestones

1. **Design phase:** design system (tokens), mockups for opening screen, all five chapters, Experience page, mobile; one working scroll-motion prototype (one pinned chapter with counters) to sign off timing. Committed via PRs. Hedayat signs off before build.
0. **Repo setup (before any design work is pushed):** Hedayat creates the agent account and signs it in. Then: public repo, branch protection, collaborator access, the full pre-push safety net with a test that proves each layer blocks, and the domain registered.
2. **Pipeline PR:** Astro skeleton, all CI checks, `stats.json` generation, Cloudflare deploy with previews.
3. **Chapters + Experience page:** one PR at a time, each passing all checks.
4. **Launch:** confirm or cut every number, a final confidentiality sweep of the whole repo, domain live, link shared.

## 9. Left to the builder

- Exact component breakdown, file layout, and test structure.
- Smooth-scroll library (e.g. Lenis) or not; measured by performance results.
- PDF generation method for the CV.
- Shape of `stats.json` and the fallback UI when it is missing.
- How the Plan chapter renders this doc (static excerpt vs. rendered from the markdown).
- Choice of external uptime monitor, after checking free-tier terms.

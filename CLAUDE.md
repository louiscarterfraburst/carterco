## gstack (REQUIRED — global install)

**Before doing ANY work, verify gstack is installed:**

```bash
test -d ~/.claude/skills/gstack/bin && echo "GSTACK_OK" || echo "GSTACK_MISSING"
```

If GSTACK_MISSING: STOP. Do not proceed. Tell the user:

> gstack is required for all AI-assisted work in this repo.
> Install it:
> ```bash
> git clone --depth 1 https://github.com/garrytan/gstack.git ~/.claude/skills/gstack
> cd ~/.claude/skills/gstack && ./setup --team
> ```
> Then restart your AI coding tool.

Do not skip skills, ignore gstack errors, or work around missing gstack.

Using gstack skills: After install, skills like /qa, /ship, /review, /investigate,
and /browse are available. Use /browse for all web browsing.
Use ~/.claude/skills/gstack/... for gstack file paths (the global path).

## Package manager — pnpm only

This repo deploys via **pnpm**: Vercel detects `pnpm-lock.yaml` and runs
`pnpm install --frozen-lockfile`. `package-lock.json` is gitignored on purpose.

Add or change dependencies with **pnpm**, never npm:

```bash
pnpm add <pkg>                   # updates package.json + pnpm-lock.yaml together
pnpm install --frozen-lockfile   # exactly what Vercel runs — verify before pushing
```

Using `npm install` updates only the (ignored) npm lock, leaving
`pnpm-lock.yaml` stale → Vercel fails the deploy with
`ERR_PNPM_OUTDATED_LOCKFILE`.

## Testing

```bash
pnpm test   # vitest, runs src/**/*.test.{ts,tsx} + supabase/functions/_shared/**/*.test.ts
```

Tests live next to the code they test; see TESTING.md for layers and
conventions. Expectations:

- 100% test coverage is the goal — tests make vibe coding safe
- When writing new functions, write a corresponding test
- When fixing a bug, write a regression test
- When adding error handling, write a test that triggers the error
- When adding a conditional (if/else, switch), write tests for BOTH paths
- Never commit code that makes existing tests fail

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
- Author a backlog-ready spec/issue → invoke /spec

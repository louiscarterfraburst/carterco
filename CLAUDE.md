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

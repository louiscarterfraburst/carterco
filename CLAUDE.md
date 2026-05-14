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

## Design System

Read `DESIGN.md` before any visual, UI, or marketing-copy change on `carterco.dk`.

Positioning is **fractional GTM engineer, not a SaaS**. That governs everything:
no `/pricing`, no `/features`, no signup flows, no "solo / én mand" framing.
All CTAs lead to a conversation (quiz → Calendly, mailto, phone).

Fonts, colors, motion rules, forbidden/required patterns, and current
implementation gaps all live in `DESIGN.md`. If a request would change any of
those, update `DESIGN.md` first, then the code.

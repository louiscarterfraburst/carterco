# Testing

100% test coverage is the key to great vibe coding. Tests let you move fast,
trust your instincts, and ship with confidence — without them, vibe coding is
just yolo coding. With tests, it's a superpower.

## Framework

[Vitest](https://vitest.dev) 4 with `@testing-library/react` + jsdom for
component tests. Config in `vitest.config.ts` (mirrors the `@/` path alias from
tsconfig).

## Running tests

```bash
pnpm test          # full suite, what CI and /ship run
pnpm exec vitest   # watch mode while developing
```

CI runs `pnpm test` on every push/PR via `.github/workflows/test.yml`.

## Test layers

- **Unit tests** — pure logic next to the code it tests, named `*.test.ts`
  (e.g. `src/app/outreach/flow.test.ts` covers `classifyNode`/`nodeLabel`/
  `activeArms`). Write these for any branching logic. Pure modules shared by
  edge functions are covered too — `supabase/functions/_shared/**/*.test.ts`
  is in the vitest include (e.g. `send-queue.test.ts` pins the drip-queue
  slot math, `business-time.test.ts` the Copenhagen business-hours window).
- **Component tests** — `*.test.tsx` with `@testing-library/react` when a
  component has behavior worth pinning (jsdom environment is preconfigured).
- **Integration/E2E** — none yet; the OTP-gated cockpit makes browser E2E a
  deliberate later step.

## Conventions

- Test files live next to the source file: `foo.ts` → `foo.test.ts`.
- Test real behavior with meaningful assertions — never `expect(x).toBeDefined()`.
- Build row/fixture helpers with sensible defaults and override only what the
  case is about (see `row()` in `flow.test.ts`).
- Never import secrets or live API keys in tests.

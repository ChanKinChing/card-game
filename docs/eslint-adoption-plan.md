# ESLint Adoption Plan

**Status:** Proposed · **Date:** 2026-11-13

> The repository has no linter. `tsc` catches type errors and the readability gate
> catches four formatting rules, but nothing catches the class of bug that
> compiles cleanly and still misbehaves: a promise nobody awaited, a `switch` that
> falls through, an `async` function with no `await`. This document is the plan to
> close that gap without a 3,000-line reformat commit.

Related reading: [`readability-gate.md`](readability-gate.md) (the existing
mechanical gates), [`architecture-import-policy.md`](architecture-import-policy.md)
(the dependency-direction gate), [`design-principles.md`](design-principles.md).

---

## Why now

The audit that produced this plan found the same shape of defect three times in
one session:

| Symptom | What a linter would have said |
|---|---|
| `void ready.then(...)` written by hand to silence a floating promise | `@typescript-eslint/no-floating-promises` |
| A `shutdown` handler that called `io.close()` and never awaited the callback | `@typescript-eslint/no-floating-promises` |
| An `async` route handler whose body had no `await` | `@typescript-eslint/require-await` |

None of these are type errors. All three are the kind of thing a reviewer catches
by luck. The codebase already contains hand-written workarounds for the first
one — `void ready.then(...)` appears in `apps/server/src/application.ts` — which
is the clearest possible signal that the rule is worth having: the author knew
the hazard and had no tool to enforce the fix.

---

## Scope, measured

| Metric | Value |
|---|---|
| TypeScript files (excluding `node_modules`, `dist`, `coverage`, `build`) | 606 |
| Total lines | 87,418 |
| Files with a line over 200 characters | 151 |
| Files with a line over 300 characters | 39 |
| Longest single line | 651 characters (`apps/admin/pages/Accounts.tsx`) |
| Existing ESLint / Prettier / `.editorconfig` config | none |
| `eslint` in `node_modules` | absent |

The line-length numbers matter because they set the cost of the formatting
decision below. 151 files already violate a 200-column limit; a Prettier run
would touch all of them.

---

## The two-tool split

**ESLint finds bugs. Prettier formats.** Do not let ESLint format.

This is not a preference, it is the only configuration that stays maintainable.
Stylistic ESLint rules (`indent`, `quotes`, `semi`, `max-len`) are deprecated in
ESLint core precisely because they fight Prettier, and every fight is resolved by
adding an exception until the config is unreadable. The split gives each tool one
job:

| Tool | Owns | Fails the build on |
|---|---|---|
| `tsc -b` | Types | Type errors |
| ESLint | Correctness | Bug-class rules only |
| Prettier | Whitespace, quotes, wrapping | Nothing — it rewrites |
| Readability gate | Four project-specific rules | Budget overruns |

The readability gate keeps its four rules. They encode project decisions
(`undocumented-export`, `nested-ternary`) that no off-the-shelf config knows
about, and they ratchet, which ESLint cannot do.

---

## Phase 1 — Correctness only, no formatting

**Goal:** a green `npm run lint` on the current tree with zero source changes.

### Dependencies

```
eslint@^9
typescript-eslint@^8
```

That is all. No `eslint-config-airbnb`, no `eslint-plugin-import` (the
architecture test already enforces import direction, and it does so with the
project's own rules rather than a generic plugin's).

### Config

`eslint.config.js` at the repository root, flat config, ESM:

```js
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/coverage/**', '**/build/**', '**/node_modules/**', '**/*.json'] },
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // The rules this plan exists for.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/await-thenable': 'error',

      // Cheap, unambiguous, no false positives in this codebase.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-throw-literal': 'error',

      // Off: the readability gate owns these, and it ratchets.
      'max-len': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    // Tests reach into internals and stub modules; the type-aware rules produce
    // noise there without finding real bugs.
    files: ['tests/**/*.ts', '**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
    },
  },
);
```

`recommendedTypeChecked` is the important choice. The non-type-checked preset
cannot implement `no-floating-promises` at all — the rule needs the type checker
to know that a value is a `Promise`. Adopting the cheap preset would give the
illusion of linting while missing the one rule that motivated the work.

### The baseline problem

`recommendedTypeChecked` on 606 files will not be clean on day one. The
temptation is to fix everything before enabling the gate; that turns a one-day
task into a two-week one and the branch rots.

Instead: **run it, count the violations, and record the count as a budget** —
the same ratchet the readability gate already uses. Two mechanisms, pick one:

| Option | How | Trade-off |
|---|---|---|
| **A. Baseline file** | `eslint --suppress-all` writes `eslint-baseline.json`; CI runs `--suppress-file eslint-baseline.json` | Violations are frozen, new ones fail. Requires `eslint-suppressions` or ESLint 9's built-in `--suppress-*` flags. |
| **B. Per-rule budget** | A small script counts violations per rule and compares against a checked-in JSON | No extra dependency, mirrors the readability gate exactly, but the script is ~40 lines to own. |

**Recommendation: B.** The repository already has a ratcheting-budget pattern
with a documented rationale in `readability-gate.md`. Reusing it means one
concept to learn, not two, and the budget file sits next to the existing one.

### Deliverables for Phase 1

1. `eslint.config.js`
2. `npm run lint` → `eslint .`
3. `npm run lint:budget` → the ratchet check
4. `tests/architecture/lint-budget.test.ts` → fails when a rule's count rises
5. `docs/lint-gate.md` → the budget table, measured, with the same "never raise a
   budget" language as the readability gate
6. `npm run verify` gains `npm run lint:budget`

**Exit criterion:** `npm run verify` passes, and the budget file records the
measured count for every enabled rule.

---

## Phase 2 — Prettier, as a single mechanical commit

**Goal:** one commit that changes whitespace only, and a `git blame` that
survives it.

### Dependencies

```
prettier@^3
eslint-config-prettier
```

`eslint-config-prettier` turns off every ESLint rule that would fight Prettier.
It goes last in the config array.

### Config

`.prettierrc.json`:

```json
{
  "printWidth": 140,
  "singleQuote": true,
  "trailingComma": "all",
  "semi": true,
  "arrowParens": "always"
}
```

`printWidth: 140` is not arbitrary — it is the exact width the readability gate
already enforces as `max-line-length`. Choosing anything narrower would make
Prettier rewrap lines the gate considers fine, and the two tools would disagree
forever. Choosing 140 means Prettier's output is, by construction, compliant with
the gate.

### The commit

```
chore: format the tree with Prettier

No behaviour change. printWidth matches the readability gate's 140-column
limit, so this commit cannot introduce a new max-line-length violation.

Add this commit to .git-blame-ignore-revs.
```

Then:

```powershell
git config blame.ignoreRevsFile .git-blame-ignore-revs
```

`git blame` skips the commit, so history stays readable. This is the difference
between a formatting commit that is a one-time cost and one that permanently
degrades `git log -p`.

### Why this is a separate phase

If Phase 1 and Phase 2 land together, every lint violation and every whitespace
change arrive in one diff, and no reviewer can tell which is which. Separating
them means Phase 1's diff is small and reviewable, and Phase 2's diff is
provably mechanical — it can be verified by running the test suite, which must
pass unchanged.

---

## Phase 3 — CI and editor integration

**Goal:** the gate runs without anyone remembering to run it.

1. **Re-enable CI.** `.github/workflows/ci.yml.disabled` is the only workflow and
   it is disabled. Add `npm run lint:budget` to it alongside `typecheck` and
   `test:coverage`.
2. **`.editorconfig`** — 2-space indent, LF, UTF-8, final newline. Prettier reads
   it, so editors that honour it agree with the formatter before the formatter
   runs.
3. **`.vscode/settings.json`** — `"editor.formatOnSave": true`,
   `"editor.defaultFormatter": "esbenp.prettier-vscode"`,
   `"editor.codeActionsOnSave": { "source.fixAll.eslint": "explicit" }`.
4. **`.nvmrc`** — pin the Node major. The `engines` field already says
   `^20.19.0 || >=22.12.0`; a file makes it actionable.

---

## What this plan deliberately does not do

| Not doing | Why |
|---|---|
| `eslint-plugin-import` | `tests/architecture/import-boundaries.test.ts` already enforces dependency direction with project-specific rules. A generic plugin would duplicate it with less precision. |
| `eslint-plugin-react` / `react-hooks` | Worth adding later, but the 47 `.tsx` files are excluded from coverage and covered by the two-tab smoke test. Correctness rules for `.ts` come first. |
| `eslint-plugin-security` | Mostly flags patterns this codebase does not use (dynamic `require`, `eval`). Revisit if the surface grows. |
| Stylistic rules in ESLint | Prettier owns formatting. See "The two-tool split". |
| Fixing all existing violations before enabling | That is how a lint adoption dies. The budget ratchet is the mechanism that makes incremental adoption possible. |
| `noUncheckedIndexedAccess` and friends | These are `tsconfig` changes, not lint changes, and they are a separate (larger) piece of work. See the audit's Tier 2. |

---

## Effort

| Phase | Work | Risk |
|---|---|---|
| 1 | Config + budget script + gate test + doc | Low — no source changes |
| 2 | One Prettier run, one commit, one `.git-blame-ignore-revs` entry | Low — provably mechanical, verified by the test suite |
| 3 | CI, editor config, `.nvmrc` | Low |

Phase 1 is the only phase with a design decision in it (the budget mechanism).
Phases 2 and 3 are mechanical.

---

## Success criteria

- `npm run verify` runs `typecheck`, `lint:budget`, `test:coverage`, `build`.
- A new floating promise fails the build.
- A new `async` function with no `await` fails the build.
- No rule budget has ever been raised without a dated comment explaining why.
- `git blame` on any pre-formatting line still points at the commit that wrote
  the logic, not at the formatting commit.

# pi-modes

Selectable agent modes for a Pi session. The first one is **gercep** (Indonesian slang for *gerak cepat*, "move fast"): the agent ships the change without running or writing any tests, and hands you a manual QA checklist instead.

Default mode is untouched: with gercep off, this package adds no prompt rules and blocks nothing, so Pi behaves exactly as it does without it.

## Install

```bash
pi install npm:@fahrizkyputra/pi-modes
```

## Usage

| Command | What it does |
|---|---|
| `/gercep` or `/gercep on` | Switch this session to gercep mode |
| `/gercep off` | Back to the default mode |
| `/gercep status` | Show the current mode |

The status bar shows `⚡ gercep` while the mode is active.

## What gercep changes

| Skipped | How |
|---|---|
| Running test runners (`npm test`, `vitest`, `jest`, `node --test`, `pytest`, `go test`, `cargo test`, …) | Prompt rule **and** blocked at tool level |
| Typecheck (`tsc`, `npm run typecheck`, `mypy`, `pyright`, `cargo check`, …) | Prompt rule **and** blocked |
| Lint (`eslint`, `npm run lint`, `ruff`, `biome check`, `cargo clippy`, …) | Prompt rule **and** blocked |
| Build (`npm run build`, `next build`, `go build`, `cargo build`, …) | Prompt rule **and** blocked |
| Writing test files (`*.test.*`, `*.spec.*`, `*_test.*`, `tests/`, `__tests__/`) | Prompt rule **and** `write`/`edit` blocked |
| The agent verifying its own work (running the app, curl, browser, screenshots) | Prompt rule only — indistinguishable from normal work |

Compound commands are checked segment by segment: `cd app && npm test` is blocked, `npm run dev` and `npm install` are not. The rules also state that skills demanding tests or verification (test-driven-development, verification-before-completion, and similar) do not apply while gercep is on.

### QA checklist

Every response that changed files ends with:

```
### QA checklist
- [ ] Open /login and sign in with a normal account
      → redirected to /dashboard, your name shows in the header
- [ ] Sign in with a wrong password
      → "Email atau password salah" appears, you stay on /login

Not verified: tests, typecheck, and lint were skipped; src/auth.ts has no test.
```

The checklist is written in the language of the conversation; only the `### QA checklist` heading stays English, because the package looks for it. If the agent changed files and forgot the checklist, the package asks once for it before the run ends.

### Asking for a check anyway

Ask explicitly in your message and that category opens **for that one response**:

| You write | Unlocks |
|---|---|
| "jalankan test dulu", "run the tests", "tulis test untuk ini", `npm test` | test runners and test files |
| "tolong build", "build dulu", `pnpm build` | build |
| "cek typecheck", "run a type-check" | typecheck |
| "lint dulu", "run lint" | lint |

A verb is required, and negations never unlock: "jangan test dulu", "test-nya nanti saja", "don't run the build", and "jalankan test tapi jangan build" (build stays blocked) all behave as you would expect. `/gercep off` always works if detection guesses wrong.

### Scope

- The mode is **per session** and persisted in it: it survives `/reload` and reopening the session with `/resume`. Other and new sessions start in default mode.
- **Subagents** started from a gercep session inherit gercep through the `PI_MODES_ACTIVE` environment variable.
- Forks and clones of a gercep session start in gercep too, because the mode entry is copied with the history.

## Limits

- File changes are detected from successful `write`/`edit` calls. Edits through bash (`sed -i`, `cat > file`) are not seen, so for those the checklist relies on the prompt rule alone.
- Unknown verification scripts (`./check.sh`) are not recognized as tests; the prompt rule is what stops them.

## Development

```bash
npm install
npm test          # node:test, no Pi required
npm run typecheck
npm run test:e2e  # real Pi over RPC with a scripted model: block, allowed write, QA follow-up, reopen
```

## License

MIT

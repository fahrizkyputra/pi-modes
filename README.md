# pi-modes

Selectable, independent agent modes for a Pi session:

| Mode | Command | In one line |
|---|---|---|
| **gercep** (*gerak cepat*, "move fast") | `/gercep` | No tests, typecheck, lint, or build — every response that changes files ends with a manual QA checklist |
| **hati-hati** ("careful") | `/hati-hati` | Every risky command needs your confirmation — every response that ran one ends with a rollback section |
| **auto-effort** | `/auto-effort` | Before each prompt you send, a small judge model sets thinking to `medium`, `high`, or `xhigh` |

Modes combine (`⚡ gercep · 🛡 hati-hati` = fast but safe on servers). With every mode off — the default — this package adds no prompt rules, blocks nothing, and asks nothing, so Pi behaves exactly as it does without it.

## Install

```bash
pi install npm:@fahrizkyputra/pi-modes
```

## Usage

| Command | What it does |
|---|---|
| `/gercep` or `/gercep on` · `/gercep off` | Turn gercep on or off for this session |
| `/hati-hati` or `/hati-hati on` · `/hati-hati off` | Turn hati-hati on or off for this session |
| `/auto-effort` or `/auto-effort on` · `/auto-effort off` | Turn auto-effort on or off for this session |
| `/auto-effort model <provider/id>` | Set the judge model for every session (default `9router/cc/claude-haiku-5-5`) |
| `/gercep status` · `/hati-hati status` · `/auto-effort status` | Show the active modes |

The status bar shows the active modes, e.g. `⚡ gercep · 🛡 hati-hati`, and so does the line shown while the agent is working: `Working ⚡ gercep`, `Working ⚡ gercep · 🛡 hati-hati`. With every mode off it is Pi's own `Working` again.

While gercep is on and the agent is working, that whole top border flashes **bright yellow ↔ bright orange four times a second**, so a fast-and-loose session is impossible to miss. It returns to the theme color as soon as the agent stops or gercep turns off. The flash uses a subclass of Pi's own editor; if another extension already installed a custom editor, pi-modes leaves it alone and skips the flash.

(Terminal UI only; RPC clients such as pi-web keep their own indicator.)

## Gercep: what it changes

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

## Hati-hati: what asks for confirmation

A dialog shows the full command and why it is risky — **Yes** runs it, **No** blocks it and tells the agent to find another way or ask you.

| Category | Asks | Does not ask |
|---|---|---|
| Remote / production | ssh that restarts or stops services, `docker compose up/down`, kills processes, writes or deletes files, runs migrations, `git pull` on the server; interactive ssh; `scp`/`rsync` uploads; `rsync --delete`; `kubectl apply/delete`, `helm upgrade` | ssh that only reads: `cat`, `tail`, `journalctl`, `systemctl status`, `docker ps/logs`; `rsync -n` dry runs; downloads |
| Release & publish | force push, push to `main`/`master`/`production`/`release*`, pushing tags, deleting remote branches, `npm publish/unpublish/deprecate`, `gh release create`, `gh pr merge`, `gh repo delete`, deploy commands (`vercel --prod`, `fly deploy`, `wrangler deploy`, `terraform apply`, `npm run deploy`, `./deploy.sh`) | `git push` to a work branch, `gh pr create`, `npm view` |
| Database | migrations (`prisma migrate deploy`, `alembic upgrade`, `artisan migrate`, `manage.py migrate`, `rails db:migrate`, `knex migrate`), SQL that writes or drops through `psql`/`mysql`/`mongosh`/`redis-cli` (also via `docker exec`), running `.sql` files | `SELECT`, `migrate:status`, `prisma generate` |
| Destructive local | `rm -r` outside temp, `git reset --hard`, `git clean -f`, `git branch -D`, `git tag -d`, `chmod/chown -R`, `docker rm/prune/compose down` | `rm -rf` in `/tmp`, `$TMPDIR`, `mktemp` paths, `node_modules`, `dist`, `.cache`; plain `rm` of files |

Without an interactive UI (RPC/print mode, subagents), risky commands are refused instead of run silently.

### Rollback section

Every response that ran a confirmed risky command ends with:

```
### Rollback
- `ssh prod 'systemctl restart app-api'`
  → git checkout v1.4.2 && systemctl restart app-api
- `git push origin main`
  → git revert <sha> && git push origin main

Cannot be rolled back: npm publish 0.3.0 (npm version numbers cannot be reused).
```

If the agent forgets it, the package asks once. When gercep is on too, a single follow-up asks for both the QA checklist and the rollback section.

## Auto-effort: what it changes

Before each prompt you type, the judge model gets your prompt plus the last ~500 characters of the previous answer (so "lanjut" is rated by the work it continues) and picks a level:

| Level | For |
|---|---|
| `medium` | A quick question, a small edit, a rename, one clear file |
| `high` | A bug fix, a medium feature, analysis, a code review, an ordinary multi-step task |
| `xhigh` | A multi-file refactor or migration, hard debugging, a long investigation, heavy web or codebase research, anything likely over 30 minutes |

The rubric follows [Anthropic's effort guidance](https://platform.claude.com/docs/en/build-with-claude/effort). The status bar shows `🧠 auto→xhigh` and the Working line `Working 🧠 xhigh`; `/auto-effort status` adds the judge's reason.

| Situation | Behavior |
|---|---|
| Judge fails, times out (3 s), or answers nonsense | `high`, with a one-line warning |
| You change the level yourself (Shift+Tab, `/thinking`) | Auto-effort pauses and keeps your level; `/auto-effort on` resumes it |
| You switch models | Not a manual change: Pi clamps the level to the new model, auto-effort keeps going |
| `/auto-effort off` | Puts back the level you had before turning it on |
| Messages from extensions, steering and follow-ups queued while the agent runs | Not judged: the level stays as it is |
| Model without `xhigh` | Pi clamps to the closest level the model supports |

Each judged prompt costs one small judge call (about one second with Haiku 5.5, about 1–2k input tokens). The judge model is saved in `~/.pi/agent/pi-modes.json`; on/off is per session.

## Scope

- Modes are **per session** and persisted in it: it survives `/reload` and reopening the session with `/resume`. Other and new sessions start in default mode.
- **Subagents** inherit gercep and hati-hati through the `PI_MODES_ACTIVE` and `PI_MODES_CAREFUL` environment variables. Auto-effort never runs in subagents (`PI_SUBAGENT_CHILD=1`); they keep the level from their own agent config.
- Forks and clones start with the same modes, because the mode entry is copied with the history.

## Limits

- File changes are detected from successful `write`/`edit` calls. Edits through bash (`sed -i`, `cat > file`) are not seen, so for those the checklist relies on the prompt rule alone.
- Unknown verification scripts (`./check.sh`) are not recognized as tests; the prompt rule is what stops them.
- Hati-hati recognizes risky commands by pattern. A wrapper script whose name does not mention deploy/release/publish/migrate (e.g. `./go.sh`) is not recognized; the prompt rule asks the agent to announce risky steps, but only recognized commands get a dialog.

## Development

```bash
npm install
npm test          # node:test, no Pi required
npm run typecheck
npm run test:e2e  # real Pi over RPC with a scripted model, for every mode
```

## License

MIT

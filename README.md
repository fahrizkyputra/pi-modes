# pi-modes

Selectable, independent agent modes for a Pi session:

| Mode | Command | In one line |
|---|---|---|
| **gercep** (*gerak cepat*, "move fast") | `/gercep` | No tests, typecheck, lint, or build — every response that changes files ends with a manual QA checklist |
| **hati-hati** ("careful") | `/hati-hati` | Every risky command needs your confirmation — every response that ran one ends with a rollback section |

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
| `/gercep status` · `/hati-hati status` | Show the active modes |

The status bar shows the active modes, e.g. `⚡ gercep · 🛡 hati-hati`.

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
- `ssh prod 'systemctl restart clipcut-api'`
  → git checkout v1.4.2 && systemctl restart clipcut-api
- `git push origin main`
  → git revert <sha> && git push origin main

Cannot be rolled back: npm publish 0.3.0 (npm version numbers cannot be reused).
```

If the agent forgets it, the package asks once. When gercep is on too, a single follow-up asks for both the QA checklist and the rollback section.

## Scope

- Modes are **per session** and persisted in it: it survives `/reload` and reopening the session with `/resume`. Other and new sessions start in default mode.
- **Subagents** inherit the active modes through the `PI_MODES_ACTIVE` and `PI_MODES_CAREFUL` environment variables.
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
npm run test:e2e  # real Pi over RPC with a scripted model, for both modes
```

## License

MIT

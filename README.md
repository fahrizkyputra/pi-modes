# pi-modes

Selectable, independent agent modes for a Pi session:

| Mode | Command | In one line |
|---|---|---|
| **gercep** (*gerak cepat*, "move fast") | `/gercep` | No tests, typecheck, lint, or build — every response that changes files ends with a manual QA checklist |
| **hati-hati** ("careful") | `/hati-hati` | Every risky command needs your confirmation — every response that ran one ends with a rollback section |
| **auto-effort** | `/auto-effort` | Before each prompt you send, a small judge model sets thinking to `medium`, `high`, or `xhigh` |
| **auto-review** | `/auto-review` · `/review` | An independent reviewer model (Opus 5.5 by default) checks each task's diff; critical/major findings go back to the agent, then one re-review |

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
| `/auto-review` or `/auto-review on` · `/auto-review off` | Turn automatic review on or off for this session |
| `/auto-review model <provider/id>` | Set the reviewer model for every session (default `9router/cc/claude-opus-5-5`) |
| `/review` | Review the last task that changed files, now — also when auto-review is off |
| `/review session` · `/review uncommitted` | Review every change of this session, or everything not committed yet (including your own edits), across all repositories of a monorepo folder |
| `/gercep status` · `/hati-hati status` · `/auto-effort status` · `/auto-review status` | Show the active modes |

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

## Auto-review and /review: what happens

When a task ends (the agent settles after a prompt you sent), pi-modes looks at what changed in the git working tree since that prompt:

1. **Reviewer.** A separate agent with a **fresh context** — it never sees your conversation — gets your request, the diff, and the agent's own summary. It has **read-only tools** (`read`, `grep`, `find`, `ls`) to check callers and surrounding code, and no `edit`, `write`, or `bash`.
2. **Effort.** `high`; `xhigh` when the diff touches a risky path, more than 10 files, or more than 400 lines. Never `max`.
3. **Report.** One block in the chat, e.g.
   ```
   🔍 Review (opus-5-5 · xhigh) — 1 major, 1 minor
   [major] middleware/rate-limit.ts:18 — counter in memory
   [minor] auth/login.ts:42 — no Retry-After header
   → critical/major sent to the agent to fix; the fix gets one re-review
   ```
   Ctrl+O expands it with the reviewer's reasoning, suggested fixes, what it checked and found fine, time, and cost.
4. **Fix.** Critical and major findings go back to the agent as a hidden message. Minor ones are only reported. The agent may push back on a finding it is sure is wrong.
5. **Re-review.** Only the fix diff is reviewed, once. Whatever it finds is reported, not sent again, so a review never loops.

| When | Automatic review (`/auto-review on`) | `/review` |
|---|---|---|
| Diff of more than 20 lines | ✓ | ✓ |
| Smaller diff on a risky path | ✓ | ✓ |
| Small, safe diff (typo, one config line) | skipped | ✓ |
| Question or read-only task | skipped | "No task with file changes" |

**Risky paths** contain `auth`, `login`, `session`, `token`, `secret`, `password`, `crypto`, `payment`, `billing`, `migration`, `permission`, `.env`, or `.sql`. Add your own in `~/.pi/agent/pi-modes.json`:

```json
{ "autoReview": { "model": "9router/cc/claude-opus-5-5", "riskyPaths": ["kyc", "ledger"] } }
```

| Situation | Behavior |
|---|---|
| Reviewer fails (rate limit, missing model, timeout after 15 min) | One warning; the agent is never blocked |
| Esc while reviewing | Cancels the review |
| The agent changed nothing for the findings | No re-review |
| A rate-limited run resumed by an extension (e.g. pi-auto-resume) | Same task: the review covers everything since your prompt |
| With gercep | Review runs normally; the QA checklist follow-up comes after the fix and re-review |
| No git repository anywhere (here or inside) | Nothing is reviewed; `/review` says so |

### Monorepo folders

`/review` and `/auto-review` also work when the folder you run Pi in is **not a git repository but holds several** (`acme/` with `web`, `api`, `worker`, …), and when you run Pi inside one of them while the agent changes its siblings.

- **No fixed repository.** Each repository is saved the first time a tool call touches it, **before** the change: the repository of the file a `write`/`edit` targets (even a new file in a new folder), and the folders a `bash` command moves into with `cd <dir>`, `pushd`, or `git -C <dir>`. Repositories the task never touched are never snapshotted, so a folder with 30 repositories costs nothing extra per prompt.
- **One review across all of them.** The diffs are merged into a single report. Every path starts with its repository folder (`api/src/orders.ts`), and the reviewer is told that the change spans several repositories, so it can check that a change in one does not break code that depends on it in another. The reviewer's working folder is the folder that contains them all, so it can read files in any of them.
- **Fix and re-review.** Findings go back to the agent as usual. The re-review covers only what the fix changed, including a repository the fix touched for the first time.
- **`/review uncommitted`** scans from the nearest parent folder without git (never your home folder), at most 5 levels deep, skipping `node_modules`, and includes git worktrees (`.worktrees/*`). Only repositories with uncommitted changes are reviewed. If that is more than 3 repositories or more than 3000 lines, Pi asks first — a folder of unrelated projects is not one change. Without a UI it does not run. The scan checks at most 40 repositories and says so when it stops early.
- **What it cannot see.** A repository the agent changes only through a command that does not name its folder (a script that writes elsewhere, a variable like `cd $PROJECT`) is not found; `/review uncommitted` still catches it.

**How changes are found.** Before the first change to a repository, pi-modes snapshots its working tree as a git tree object using a temporary index file (`git add -A` + `git write-tree` against a copy of the index). Your working tree, index, staged files, stash, branches, and commits are never touched, and ignored files stay out. The snapshot objects are unreachable, so `git gc` removes them eventually. This runs in every session, also with auto-review off, so `/review` works when you forgot to turn it on; one snapshot takes about 0.1 s.

**Cost.** One review is one reviewer agent run: roughly 20k input / 5k output tokens for a small change, more for big ones. With Opus 5.5 that is about $0.20–1.30 per review, plus the re-review when findings were sent to fix.

## Scope

- Modes are **per session** and persisted in it: it survives `/reload` and reopening the session with `/resume`. Other and new sessions start in default mode.
- **Subagents** inherit gercep and hati-hati through the `PI_MODES_ACTIVE` and `PI_MODES_CAREFUL` environment variables. Auto-effort and auto-review never run in subagents (`PI_SUBAGENT_CHILD=1`); subagents keep the level from their own agent config.
- Forks and clones start with the same modes, because the mode entry is copied with the history.

## Limits

- File changes are detected from successful `write`/`edit` calls. Edits through bash (`sed -i`, `cat > file`) are not seen, so for those the checklist relies on the prompt rule alone.
- Unknown verification scripts (`./check.sh`) are not recognized as tests; the prompt rule is what stops them.
- Auto-review reviews what changed in the working tree since your prompt. If you edit files yourself while the agent works, those edits are in the diff too.
- The review progress line and Esc-to-cancel are terminal-UI features; in RPC clients the review still runs and reports, with a status text instead.
- Hati-hati recognizes risky commands by pattern. A wrapper script whose name does not mention deploy/release/publish/migrate (e.g. `./go.sh`) is not recognized; the prompt rule asks the agent to announce risky steps, but only recognized commands get a dialog.

## jcode

Gercep and hati-hati also work in [jcode](https://github.com/1jehuang/jcode), with the same rules and the same command and risk detection:

```bash
npx -y @fahrizkyputra/pi-modes jcode install     # needs Node 22.18+
```

Then, in a jcode session, `/gercep`, `/hati-hati` (and `… off`, `… status`). Reload skills first in a session that was already open (`skill_manage reload_all`).

| | Pi | jcode |
|---|---|---|
| Turning a mode on | extension command | a skill: the agent runs `jcode-modes on <mode>`, which records the mode for this session and prints its rules into the conversation |
| Blocking | `tool_call` handler | a `[hooks] pre_tool` gate in `~/.jcode/config.toml`; the block reason goes back to the agent |
| "jalankan test" unlocks tests | yes | yes: the gate reads your latest message from the session file |
| Hati-hati confirmation | a yes/no dialog | the command is held with a code; you type the `!` line it shows, e.g. `!jcode-modes approve 74d450`, then tell the agent to continue. The approval is for that exact command, once, within 10 minutes. The agent cannot approve itself or turn hati-hati off without the same approval |
| QA checklist / rollback section | asked again if missing | prompt rule only (jcode has no hook that can send a follow-up) |
| Auto-effort, auto-review | yes | not ported. jcode has its own `autoreview` and `autojudge` |

The installer copies the code to `~/.jcode/plugins/pi-modes/`, links `/gercep` and `/hati-hati` into `~/.jcode/skills` (never over an existing folder), and links `jcode-modes` into `~/.local/bin` when that is on `PATH` and free. It edits only its own command in `[hooks]`; the first edit keeps `config.toml.pi-modes.bak`. With no mode on, the gate exits in the shell without starting Node. A broken gate fails open.

Update: run the install line again. Remove: `jcode-modes uninstall` (held behind approval while hati-hati is on).

## Development

```bash
npm install
npm test          # node:test, no Pi required
npm run typecheck
npm run test:e2e  # real Pi over RPC with a scripted model, for every mode
```

## License

MIT

/**
 * What counts as "risky" in hati-hati (careful) mode.
 *
 * Four categories need a human confirmation: changing remote/production
 * systems, releases and publishing, database migrations and SQL writes, and
 * destructive local commands. Read-only work — including ssh that only reads
 * logs or status — never asks.
 *
 * Heredoc bodies are lifted out before splitting, so a script that merely
 * mentions `rm -rf` in a string is not flagged, while `ssh host <<EOF ... EOF`
 * is judged by what the heredoc actually runs remotely.
 */

import { splitCommand } from "./classify.ts";

export type RiskCategory = "remote" | "release" | "database" | "destructive";

export interface RiskMatch {
	category: RiskCategory;
	/** The command segment that triggered it, as written. */
	action: string;
	/** Why it is risky, one short phrase. */
	reason: string;
}

export interface RiskContext {
	/** Branch checked out in `cwd` (or the session cwd when undefined). */
	currentBranch?: (cwd: string | undefined) => string | undefined;
}

const PROTECTED_BRANCH = /^(?:main|master|production|prod|release|releases?[/-].+)$/i;

const SAFE_DIR_NAMES = new Set([
	"node_modules",
	"dist",
	".cache",
	".next",
	".turbo",
	"coverage",
	"__pycache__",
	".pytest_cache",
]);

/** Shell-ish tokenizer: whitespace splits, quotes group, backslash escapes. */
export function tokenize(segment: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let started = false;
	for (let i = 0; i < segment.length; i++) {
		const char = segment[i] ?? "";
		if (quote) {
			if (char === quote) quote = undefined;
			else current += char;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			started = true;
			continue;
		}
		if (char === "\\" && i + 1 < segment.length) {
			current += segment[i + 1] ?? "";
			started = true;
			i++;
			continue;
		}
		if (/\s/.test(char)) {
			if (started || current.length > 0) tokens.push(current);
			current = "";
			started = false;
			continue;
		}
		current += char;
		started = true;
	}
	if (started || current.length > 0) tokens.push(current);
	return tokens;
}

/** Drop env assignments and wrappers (`sudo -E`, `time`, `nohup`, `timeout 30`). */
function stripPrefix(tokens: string[]): string[] {
	const rest = [...tokens];
	for (;;) {
		const head = rest[0];
		if (head === undefined) return rest;
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(head)) {
			rest.shift();
			continue;
		}
		if (head === "sudo" || head === "doas") {
			rest.shift();
			while (rest[0]?.startsWith("-")) {
				const flag = rest.shift();
				if (flag === "-u" || flag === "-g") rest.shift();
			}
			continue;
		}
		if (["time", "nice", "nohup", "exec", "command", "env"].includes(head)) {
			rest.shift();
			continue;
		}
		if (head === "timeout") {
			rest.splice(0, 2);
			continue;
		}
		return rest;
	}
}

/** `2>/dev/null`, `> out.log`, `&>x`, `2>&1`, `&` → removed, so they never look like arguments. */
function stripRedirections(tokens: string[]): string[] {
	const result: string[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i] ?? "";
		if (token === "&") continue;
		if (/^(?:\d*|&)>>?&?\d*$/.test(token) || /^<$/.test(token)) {
			i++; // the target is the next token
			continue;
		}
		if (/^(?:\d*|&)>>?\S+$/.test(token) || /^<\S+$/.test(token)) continue;
		result.push(token);
	}
	return result;
}

function baseName(token: string | undefined): string {
	return (token ?? "").split("/").pop() ?? "";
}

/** Pull heredoc bodies out of the command, keeping the `<<EOF` marker in place. */
export function extractHeredocs(command: string): { stripped: string; bodies: string[] } {
	const lines = command.split("\n");
	const kept: string[] = [];
	const bodies: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		kept.push(line);
		const start = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line);
		if (!start) continue;
		const delimiter = start[2] ?? "";
		const body: string[] = [];
		i++;
		while (i < lines.length && (lines[i] ?? "").trim() !== delimiter) {
			body.push(lines[i] ?? "");
			i++;
		}
		bodies.push(body.join("\n"));
	}
	return { stripped: kept.join("\n"), bodies };
}

const HEREDOC_MARKER = /<<-?\s*['"]?[A-Za-z_]/g;

export function classifyRisk(command: string, context: RiskContext = {}): RiskMatch[] {
	return classifyInternal(command, context, false);
}

function classifyInternal(command: string, context: RiskContext, remote: boolean): RiskMatch[] {
	const { stripped, bodies } = extractHeredocs(command);
	const matches: RiskMatch[] = [];
	let heredocIndex = 0;
	let cwd: string | undefined;

	for (const raw of splitCommand(stripped)) {
		const markers = raw.match(HEREDOC_MARKER)?.length ?? 0;
		const segmentBodies: string[] = [];
		for (let k = 0; k < markers; k++) segmentBodies.push(bodies[heredocIndex++] ?? "");
		const body = segmentBodies.join("\n");

		const tokens = stripRedirections(stripPrefix(tokenize(raw)).filter((token) => !/^<<-?/.test(token)));
		if (tokens.length === 0) continue;
		if (tokens[0] === "cd") {
			cwd = tokens[1];
			continue;
		}

		const match = remote
			? classifyRemoteSegment(tokens, raw, body, context)
			: classifySegment(tokens, raw, body, { ...context, cwd });
		if (match) matches.push(match);
	}
	return matches;
}

interface SegmentContext extends RiskContext {
	cwd?: string;
}

function classifySegment(tokens: string[], raw: string, body: string, context: SegmentContext): RiskMatch | undefined {
	const command = baseName(tokens[0]);
	const action = raw.trim();
	const args = tokens.slice(1);

	switch (command) {
		case "ssh":
			return sshRisk(args, action, body, context);
		case "scp":
			return uploadRisk(args, action, "scp");
		case "rsync":
			if (args.some((arg) => arg === "--dry-run" || /^-[a-zA-Z]*n[a-zA-Z]*$/.test(arg))) return undefined;
			if (args.some((arg) => arg.startsWith("--delete"))) {
				return { category: "remote", action, reason: "rsync --delete removes files at the destination" };
			}
			return uploadRisk(args, action, "rsync");
		case "kubectl": {
			const sub = firstPositional(args);
			if (sub && /^(?:apply|delete|rollout|scale|drain|cordon|patch|edit|replace|create|set)$/.test(sub)) {
				return { category: "remote", action, reason: `kubectl ${sub} changes the cluster` };
			}
			return undefined;
		}
		case "helm": {
			const sub = firstPositional(args);
			if (sub && /^(?:install|upgrade|uninstall|rollback|delete)$/.test(sub)) {
				return { category: "remote", action, reason: `helm ${sub} changes the cluster` };
			}
			return undefined;
		}
		case "git":
			return gitRisk(args, action, context);
		case "rm":
			return rmRisk(args, action);
		case "chmod":
		case "chown":
			if (args.some((arg) => /^-[a-zA-Z]*R/.test(arg) || arg === "--recursive")) {
				return { category: "destructive", action, reason: `${command} -R changes permissions recursively` };
			}
			return undefined;
		case "dd":
			if (args.some((arg) => /^of=\/dev\//.test(arg))) {
				return { category: "destructive", action, reason: "dd writes to a device" };
			}
			return undefined;
		case "shred":
			return { category: "destructive", action, reason: "shred destroys file contents" };
		case "docker":
		case "docker-compose":
		case "podman":
			return dockerRisk(command, args, action, raw, body);
		default:
			break;
	}

	if (/^mkfs(?:\.|$)/.test(command)) return { category: "destructive", action, reason: "mkfs formats a filesystem" };

	return releaseRisk(command, args, action) ?? databaseRisk(tokens, action, raw, body);
}

function firstPositional(args: string[]): string | undefined {
	return args.find((arg) => !arg.startsWith("-"));
}

// ---- remote -----------------------------------------------------------------

const SSH_OPTIONS_WITH_VALUE = new Set(["-p", "-i", "-o", "-J", "-l", "-F", "-L", "-R", "-D", "-E", "-b", "-c", "-m", "-O", "-Q", "-S", "-W", "-w", "-B"]);

function sshRisk(args: string[], action: string, body: string, context: SegmentContext): RiskMatch | undefined {
	let index = 0;
	while (index < args.length && (args[index] ?? "").startsWith("-")) {
		const flag = args[index] ?? "";
		index += SSH_OPTIONS_WITH_VALUE.has(flag) ? 2 : 1;
	}
	const host = args[index];
	if (!host) return undefined;
	// Quoted remote commands arrive as one token; unquoted ones as several. Either way they are
	// re-parsed as a shell command on the remote side.
	const remoteCommand = [args.slice(index + 1).join(" "), body].filter((part) => part.trim().length > 0).join("\n");

	if (remoteCommand.trim().length === 0) {
		// `ssh -T git@github.com`, `ssh -O check host`: no remote shell is opened.
		const noShell = args.includes("-T") || args.includes("-N") || args.includes("-O") || /^git@/.test(host);
		if (noShell) return undefined;
		return { category: "remote", action, reason: `opens an interactive shell on ${host}` };
	}

	const nested = classifyInternal(remoteCommand, context, true);
	const first = nested[0];
	if (first) return { category: "remote", action, reason: `${first.reason} on ${host}` };
	return undefined;
}

function uploadRisk(args: string[], action: string, tool: string): RiskMatch | undefined {
	const positional = args.filter((arg) => !arg.startsWith("-"));
	const destination = positional.at(-1);
	if (positional.length >= 2 && destination && /^(?:[\w.-]+@)?[\w.-]+:/.test(destination)) {
		const host = destination.split(":")[0];
		return { category: "remote", action, reason: `${tool} uploads files to ${host}` };
	}
	return undefined;
}

/** Segments that change something on a remote host. Reads (logs, status, ps) pass. */
function classifyRemoteSegment(tokens: string[], raw: string, body: string, context: RiskContext): RiskMatch | undefined {
	const command = baseName(tokens[0]);
	const sub = tokens[1] ?? "";
	const action = raw.trim();
	const hit = (reason: string): RiskMatch => ({ category: "remote", action, reason });

	if ((command === "systemctl" || command === "service") && tokens.some((token) => /^(?:restart|stop|start|reload|disable|enable|kill|mask)$/.test(token))) {
		return hit(`${command} changes a running service`);
	}
	if (command === "docker" || command === "docker-compose" || command === "podman") {
		const words = tokens.slice(1).filter((token) => !token.startsWith("-"));
		if (words.some((word) => /^(?:up|down|restart|stop|start|rm|rmi|kill|pull|build|run|prune|create|deploy|scale)$/.test(word))) {
			return hit(`${command} ${words.join(" ")} changes containers`);
		}
	}
	if (command === "pm2" && /^(?:restart|stop|reload|delete|start|kill)$/.test(sub)) return hit(`pm2 ${sub} changes a process`);
	if (command === "supervisorctl" && /^(?:restart|stop|start|reload|update)$/.test(sub)) return hit(`supervisorctl ${sub} changes a process`);
	if (["kill", "pkill", "killall"].includes(command)) return hit(`${command} stops processes`);
	if (["reboot", "shutdown", "poweroff", "halt"].includes(command)) return hit(`${command} takes the host down`);
	if (["apt", "apt-get", "yum", "dnf", "apk", "brew"].includes(command) && /^(?:install|remove|upgrade|purge|update|add|del)$/.test(sub)) {
		return hit(`${command} ${sub} changes installed packages`);
	}
	if (["npm", "pnpm", "yarn", "bun", "pip", "pip3", "composer"].includes(command) && /^(?:install|i|ci|add|remove|uninstall|update|upgrade)$/.test(sub)) {
		return hit(`${command} ${sub} changes dependencies`);
	}
	if (command === "git" && /^(?:pull|reset|checkout|switch|merge|rebase|push|clean|stash|fetch)$/.test(sub)) return hit(`git ${sub} changes the deployed code`);
	if (["rm", "mv", "cp", "tee", "truncate", "ln", "rsync", "unzip", "tar"].includes(command)) {
		if (command !== "tar" || tokens.some((token) => /^-?[a-zA-Z]*x/.test(token))) return hit(`${command} changes files`);
	}
	if (command === "sed" && tokens.some((token) => /^-i/.test(token))) return hit("sed -i edits files");
	if ((command === "chmod" || command === "chown") ) return hit(`${command} changes permissions`);
	if (command === "crontab" && tokens.some((token) => /^-[er]$/.test(token))) return hit("crontab changes scheduled jobs");
	if (command === "nginx" && tokens.includes("-s")) return hit("nginx -s signals the server");
	if (["certbot", "ufw", "iptables"].includes(command)) return hit(`${command} changes host configuration`);
	if (/(?:^|[^0-9&>])>{1,2}\s*(?!&|\/dev\/null)[^\s>]/.test(raw)) return hit("writes a file");

	// Release/database/destructive rules apply remotely too.
	const nested = classifySegment(tokens, raw, body, context);
	if (nested) return { ...nested, category: "remote" };
	return undefined;
}

// ---- git ----------------------------------------------------------------------

function gitRisk(args: string[], action: string, context: SegmentContext): RiskMatch | undefined {
	let cwd = context.cwd;
	let index = 0;
	while (index < args.length) {
		const token = args[index] ?? "";
		if (token === "-C") {
			cwd = args[index + 1];
			index += 2;
			continue;
		}
		if (token === "-c" || token === "--git-dir" || token === "--work-tree") {
			index += 2;
			continue;
		}
		if (token.startsWith("-")) {
			index++;
			continue;
		}
		break;
	}
	const sub = args[index];
	const rest = args.slice(index + 1);

	switch (sub) {
		case "push":
			return pushRisk(rest, action, { ...context, cwd });
		case "reset":
			return rest.includes("--hard") ? { category: "destructive", action, reason: "git reset --hard discards uncommitted work" } : undefined;
		case "clean":
			return rest.some((arg) => /^-[a-zA-Z]*f/.test(arg) || arg === "--force")
				? { category: "destructive", action, reason: "git clean -f deletes untracked files" }
				: undefined;
		case "branch":
			return rest.includes("-D") || (rest.includes("--delete") && rest.includes("--force"))
				? { category: "destructive", action, reason: "git branch -D deletes a branch even if unmerged" }
				: undefined;
		case "tag":
			return rest.includes("-d") || rest.includes("--delete")
				? { category: "destructive", action, reason: "git tag -d deletes a tag" }
				: undefined;
		default:
			return undefined;
	}
}

function pushRisk(args: string[], action: string, context: SegmentContext): RiskMatch | undefined {
	const hit = (reason: string): RiskMatch => ({ category: "release", action, reason });
	if (args.some((arg) => arg === "--force" || arg === "-f" || arg.startsWith("--force-with-lease") || arg === "--force-if-includes")) {
		return hit("force push rewrites remote history");
	}
	if (args.some((arg) => arg === "--delete" || arg === "-d")) return hit("deletes a remote branch or tag");
	if (args.some((arg) => arg === "--all" || arg === "--mirror")) return hit("pushes every branch");
	if (args.includes("--tags")) return hit("pushes tags, which often trigger releases");

	const positional = args.filter((arg) => !arg.startsWith("-"));
	const refspecs = positional.slice(1);

	if (refspecs.length === 0) {
		const branch = context.currentBranch?.(context.cwd);
		if (branch === undefined) return hit("pushes the current branch, which could not be determined");
		return PROTECTED_BRANCH.test(branch) ? hit(`pushes to ${branch}`) : undefined;
	}

	for (const refspec of refspecs) {
		if (refspec.startsWith("+")) return hit("force push (+refspec) rewrites remote history");
		if (refspec.startsWith(":")) return hit(`deletes ${refspec.slice(1)} on the remote`);
		let destination = refspec.includes(":") ? (refspec.split(":")[1] ?? "") : refspec;
		destination = destination.replace(/^refs\/heads\//, "");
		if (destination === "HEAD") destination = context.currentBranch?.(context.cwd) ?? "HEAD";
		if (/^refs\/tags\//.test(destination) || /^v?\d+\.\d+(?:\.\d+)?/.test(destination)) {
			return hit(`pushes tag ${destination.replace(/^refs\/tags\//, "")}, which often triggers a release`);
		}
		if (PROTECTED_BRANCH.test(destination)) return hit(`pushes to ${destination}`);
	}
	return undefined;
}

// ---- rm -------------------------------------------------------------------

function isSafeTarget(target: string): boolean {
	if (target.includes("mktemp")) return true;
	const path = target.replace(/\/+$/, "");
	if (/^(?:\/tmp|\/private\/tmp|\/var\/folders)\/.+/.test(path)) return true;
	if (/^\$\{?[A-Za-z_]*(?:TMP|tmp|TEMP|temp|Tmp|Temp)[A-Za-z_]*\}?(?:\/.*)?$/.test(path)) return true;
	const last = path.split("/").pop() ?? "";
	return SAFE_DIR_NAMES.has(last);
}

function rmRisk(args: string[], action: string): RiskMatch | undefined {
	let recursive = false;
	const targets: string[] = [];
	let endOfFlags = false;
	for (const arg of args) {
		if (!endOfFlags && arg === "--") {
			endOfFlags = true;
			continue;
		}
		if (!endOfFlags && arg.startsWith("--")) {
			if (arg === "--recursive") recursive = true;
			continue;
		}
		if (!endOfFlags && arg.startsWith("-") && arg.length > 1) {
			if (/[rR]/.test(arg)) recursive = true;
			continue;
		}
		targets.push(arg);
	}
	if (!recursive || targets.length === 0) return undefined;
	const unsafe = targets.filter((target) => !isSafeTarget(target));
	if (unsafe.length === 0) return undefined;
	return { category: "destructive", action, reason: `rm -r deletes ${unsafe.slice(0, 3).join(", ")}${unsafe.length > 3 ? ", …" : ""}` };
}

// ---- docker -----------------------------------------------------------------

function dockerRisk(command: string, args: string[], action: string, raw: string, body: string): RiskMatch | undefined {
	const words = args.filter((arg) => !arg.startsWith("-"));
	const joined = words.join(" ");
	if (
		/^(?:rm|rmi)\b/.test(joined) ||
		/\bprune\b/.test(joined) ||
		/^(?:compose\s+)?down\b/.test(joined) ||
		/^volume\s+rm\b/.test(joined)
	) {
		return { category: "destructive", action, reason: `${command} ${words.slice(0, 2).join(" ")} removes containers, images, or volumes` };
	}
	if (/^push\b/.test(joined)) return { category: "release", action, reason: "docker push publishes an image" };
	// `docker exec db psql -c 'DROP …'`
	return databaseRisk(args, action, raw, body);
}

// ---- release ------------------------------------------------------------------

function releaseRisk(command: string, args: string[], action: string): RiskMatch | undefined {
	const hit = (reason: string): RiskMatch => ({ category: "release", action, reason });
	const words = args.filter((arg) => !arg.startsWith("-"));
	const sub = words[0] ?? "";
	const sub2 = words[1] ?? "";

	if (["npm", "pnpm", "yarn", "bun"].includes(command)) {
		if (/^(?:publish|unpublish|deprecate)$/.test(sub)) return hit(`${command} ${sub} changes the public registry`);
		if (sub === "dist-tag" && /^(?:add|rm)$/.test(sub2)) return hit(`${command} dist-tag ${sub2} moves a published tag`);
		if (command === "yarn" && sub === "npm" && sub2 === "publish") return hit("yarn npm publish changes the public registry");
		if (sub === "run" && /(?:^|[:_-])(?:deploy|release|publish)(?:$|[:_-])/.test(sub2)) return hit(`${command} run ${sub2} deploys or releases`);
		if (/^(?:deploy|release)$/.test(sub)) return hit(`${command} ${sub} deploys or releases`);
	}
	if (command === "gh") {
		if (sub === "release" && /^(?:create|delete|edit|upload)$/.test(sub2)) return hit(`gh release ${sub2} changes a public release`);
		if (sub === "pr" && sub2 === "merge") return hit("gh pr merge merges into the target branch");
		if (sub === "repo" && /^(?:delete|archive|rename|edit)$/.test(sub2)) return hit(`gh repo ${sub2} changes the repository`);
	}
	if (command === "vercel" && (args.includes("--prod") || args.includes("--production"))) return hit("vercel --prod deploys to production");
	if ((command === "fly" || command === "flyctl") && sub === "deploy") return hit(`${command} deploy deploys to production`);
	if (command === "wrangler" && /^(?:deploy|publish)$/.test(sub)) return hit(`wrangler ${sub} deploys to production`);
	if (command === "netlify" && sub === "deploy" && (args.includes("--prod") || args.includes("--production"))) return hit("netlify deploy --prod deploys to production");
	if (command === "firebase" && sub === "deploy") return hit("firebase deploy deploys to production");
	if ((command === "serverless" || command === "sls" || command === "cdk") && sub === "deploy") return hit(`${command} deploy deploys infrastructure`);
	if (command === "terraform" && /^(?:apply|destroy|import)$/.test(sub)) return hit(`terraform ${sub} changes infrastructure`);
	if (command === "pulumi" && /^(?:up|destroy|import)$/.test(sub)) return hit(`pulumi ${sub} changes infrastructure`);
	if (command === "railway" && sub === "up") return hit("railway up deploys to production");
	if (command === "make" && words.some((word) => /^(?:deploy|release|publish)(?:[-_].*)?$/.test(word))) return hit(`make ${words.join(" ")} deploys or releases`);
	if (/(?:^|[/._-])(?:deploy|release|publish|rollout)(?:[._-][\w.-]*)?(?:\.sh)?$/.test(command) && /[/.]/.test(command)) {
		return hit(`${command} looks like a deploy/release script`);
	}
	return undefined;
}

// ---- database -------------------------------------------------------------------

const SQL_CLIENTS = new Set(["psql", "mysql", "mariadb", "sqlite3", "mongosh", "mongo", "redis-cli", "clickhouse-client", "cqlsh", "pgcli", "mycli"]);
const SQL_WRITE =
	/\b(?:DROP|TRUNCATE|ALTER|GRANT|REVOKE|FLUSHALL|FLUSHDB)\b|\bDELETE\s+FROM\b|\bUPDATE\s+\S+\s+SET\b|\bINSERT\s+INTO\b|\bCREATE\s+(?:TABLE|DATABASE|INDEX|SCHEMA)\b|\.drop\(|dropDatabase|deleteMany|deleteOne|updateMany|updateOne|insertMany|insertOne/i;

/** `npx knex …`, `pnpm exec prisma …`, `yarn dlx drizzle-kit …` → the tool's own tokens. */
function unwrapRunner(tokens: string[]): string[] {
	const head = baseName(tokens[0]);
	if (head === "npx" || head === "bunx") return tokens.slice(1).filter((token, index) => index > 0 || !token.startsWith("-"));
	if ((head === "pnpm" || head === "yarn") && (tokens[1] === "exec" || tokens[1] === "dlx")) return tokens.slice(2);
	if (head === "bun" && tokens[1] === "x") return tokens.slice(2);
	return tokens;
}

function databaseRisk(original: string[], action: string, raw: string, body: string): RiskMatch | undefined {
	const hit = (reason: string): RiskMatch => ({ category: "database", action, reason });
	const tokens = unwrapRunner(original);
	const command = baseName(tokens[0]);
	const words = tokens.slice(1).filter((token) => !token.startsWith("-"));
	const sub = words[0] ?? "";
	const sub2 = words[1] ?? "";

	// Migrations.
	if (command === "prisma") {
		const rest = words;
		if ((rest[0] === "migrate" && /^(?:deploy|reset|dev|resolve)$/.test(rest[1] ?? "")) || (rest[0] === "db" && /^(?:push|execute)$/.test(rest[1] ?? ""))) {
			return hit(`prisma ${rest.slice(0, 2).join(" ")} changes the database schema`);
		}
	}
	if (command === "alembic" && /^(?:upgrade|downgrade|stamp)$/.test(sub)) return hit(`alembic ${sub} changes the database schema`);
	if (command === "php" && sub === "artisan" && /^(?:migrate(?::(?:fresh|refresh|reset|rollback|install))?|db:wipe|db:seed)$/.test(sub2)) {
		return hit(`artisan ${sub2} changes the database`);
	}
	if ((command === "python" || command === "python3") && sub === "manage.py" && /^(?:migrate|flush|loaddata)$/.test(sub2)) {
		return hit(`manage.py ${sub2} changes the database`);
	}
	if (["rails", "rake", "bin/rails"].includes(command) && /^db:(?:migrate(?::(?:redo|reset|down|up))?|rollback|reset|drop|schema:load|seed|setup)$/.test(sub)) {
		return hit(`${command} ${sub} changes the database`);
	}
	if (
		["knex", "sequelize", "typeorm", "mikro-orm", "db-migrate", "goose", "migrate", "dbmate", "flyway", "liquibase"].includes(command) &&
		/(?:migrat|\bup\b|\bdown\b|reset|rollback|update|\brun\b|latest)/.test(words.join(" ")) &&
		!/(?:status|list|info|validate|pending|make|create)\b/.test(words.join(" "))
	) {
		return hit(`${command} runs database migrations`);
	}
	if (command === "drizzle-kit" && /\b(?:push|migrate|drop)\b/.test(words.join(" "))) return hit("drizzle-kit changes the database schema");
	if (command === "supabase" && sub === "db" && /^(?:push|reset)$/.test(sub2)) return hit(`supabase db ${sub2} changes the database`);
	if (["npm", "pnpm", "yarn", "bun"].includes(command) && sub === "run" && /migrat|db:(?:push|reset|seed|drop)/.test(sub2)) return hit(`${command} run ${sub2} changes the database`);

	// SQL clients writing data, also through `docker exec db psql …`.
	const client = original.map(baseName).find((token) => SQL_CLIENTS.has(token));
	if (client) {
		if (SQL_WRITE.test(`${raw}\n${body}`)) return hit(`${client} runs a statement that writes or drops data`);
		if (original.includes("-f") || /\s<\s*\S+\.(?:sql|dump)\b/.test(raw)) return hit(`${client} runs a SQL file`);
	}
	return undefined;
}

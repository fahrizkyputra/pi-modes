import { execFileSync } from "node:child_process";
import { isAbsolute, join } from "node:path";

/** Branch checked out in `cwd` (relative to the session dir), undefined when detached or not a repo. */
export function gitBranch(cwd: string | undefined, sessionCwd: string | undefined): string | undefined {
	const base = sessionCwd ?? process.cwd();
	const dir = cwd ? (isAbsolute(cwd) ? cwd : join(base, cwd)) : base;
	try {
		const branch = execFileSync("git", ["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 2000,
		}).trim();
		return branch.length > 0 && branch !== "HEAD" ? branch : undefined;
	} catch {
		return undefined;
	}
}

import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyRisk, extractHeredocs, tokenize } from "../src/risk.ts";

const onBranch = (branch: string) => ({ currentBranch: () => branch });

function risky(command: string, branch = "feat/x"): string[] {
	return classifyRisk(command, onBranch(branch)).map((match) => match.category);
}

test("ssh: reads pass, changes ask", () => {
	for (const command of [
		"ssh prod 'tail -n 50 /var/log/app.log'",
		"ssh -p 2222 deploy@203.0.113.10 'systemctl status app-api'",
		"ssh prod journalctl -u app-worker --since today",
		"ssh prod 'docker ps && docker logs api --tail 20'",
		"ssh prod 'cat /etc/nginx/sites-enabled/app | grep server_name'",
		"ssh prod 'ls -la /srv/app > /dev/null'",
		"ssh -o BatchMode=yes root@203.0.113.10 'echo SSH_OK' > /tmp/ssh.out 2>&1 &",
		"timeout 20 ssh -T -o BatchMode=yes git@github.com 2>&1",
		"ssh prod 'cd /var/www/app && php artisan migrate:status'",
	]) {
		assert.deepEqual(risky(command), [], command);
	}
	for (const command of [
		"ssh prod 'systemctl restart app-api'",
		"ssh -i ~/.ssh/id prod 'cd /srv/app && git pull && docker compose up -d'",
		"ssh prod 'pkill -f celery'",
		"ssh prod 'rm -rf /srv/app/releases/old'",
		"ssh prod 'echo X=1 >> /srv/app/.env'",
		"ssh prod 'sed -i s/a/b/ /etc/app.conf'",
		"ssh prod",
	]) {
		assert.deepEqual(risky(command), ["remote"], command);
	}
});

test("ssh with a heredoc is judged by what it runs remotely", () => {
	assert.deepEqual(risky("ssh prod <<'EOF'\nsystemctl status app\njournalctl -n 20\nEOF"), []);
	assert.deepEqual(risky("ssh prod <<'EOF'\ncd /srv/app\nsystemctl restart app\nEOF"), ["remote"]);
});

test("uploads to another host ask, local copies do not", () => {
	assert.deepEqual(risky("scp build.tar.gz prod:/srv/app/"), ["remote"]);
	assert.deepEqual(risky("rsync -avz dist/ deploy@prod:/srv/www"), ["remote"]);
	assert.deepEqual(risky("rsync -av --delete src/ backup/"), ["remote"], "--delete is destructive anywhere");
	assert.deepEqual(risky("scp prod:/var/log/app.log ."), []);
	assert.deepEqual(risky("rsync -an --delete --itemize-changes public/build/ prod:/var/www/app/build/"), [], "dry run");
	assert.deepEqual(risky("rsync -av src/ backup/"), []);
});

test("git push: work branches pass, protected branches and force ask", () => {
	assert.deepEqual(risky("git push origin feat/login"), []);
	assert.deepEqual(risky("git push -u origin hotfix/payment"), []);
	assert.deepEqual(risky("git push", "feat/x"), []);
	assert.deepEqual(risky("cd ~/Work/pi-modes && git push -q origin main --tags"), ["release"]);
	assert.deepEqual(risky("git push origin main"), ["release"]);
	assert.deepEqual(risky("git push origin HEAD:production"), ["release"]);
	assert.deepEqual(risky("git push", "main"), ["release"], "bare push from main");
	assert.deepEqual(risky("git push --force origin feat/x"), ["release"]);
	assert.deepEqual(risky("git push --force-with-lease"), ["release"]);
	assert.deepEqual(risky("git push origin +feat/x"), ["release"]);
	assert.deepEqual(risky("git push origin --delete old-branch"), ["release"]);
	assert.deepEqual(risky("git push origin :old-branch"), ["release"]);
	assert.deepEqual(risky("git push origin v0.2.0"), ["release"]);
	assert.deepEqual(risky("git -C ../other push origin master"), ["release"]);
});

test("releases and deploys", () => {
	for (const command of [
		"npm publish --access public",
		"npm unpublish pi-x --force",
		"npm deprecate pi-x 'renamed'",
		"npm dist-tag add pkg@1.0.0 latest",
		"gh release create v1.0 --notes x",
		"gh pr merge 12 --squash",
		"gh repo delete me/x --yes",
		"vercel --prod",
		"fly deploy",
		"wrangler deploy",
		"terraform apply -auto-approve",
		"npm run deploy",
		"pnpm run release:prod",
		"./scripts/deploy.sh production",
		"make deploy",
		"docker push registry/app:1.2",
	]) {
		assert.deepEqual(risky(command), ["release"], command);
	}
	for (const command of ["npm install", "npm run dev", "gh pr create --fill", "gh release view", "npm view pkg version", "vercel", "make"]) {
		assert.deepEqual(risky(command), [], command);
	}
});

test("database migrations and SQL writes", () => {
	for (const command of [
		"npx prisma migrate deploy",
		"prisma db push",
		"alembic upgrade head",
		"php artisan migrate --force",
		"python manage.py migrate",
		"rails db:migrate",
		"npx knex migrate:latest",
		"npm run db:push",
		"psql $DATABASE_URL -c 'DELETE FROM users WHERE id = 1'",
		"psql -c \"DROP TABLE sessions\"",
		"mysql -e 'UPDATE orders SET status=\"x\" WHERE id=2' shop",
		"redis-cli FLUSHALL",
		"psql $DATABASE_URL -f schema.sql",
		"docker exec -it db psql -U app -c 'TRUNCATE jobs'",
	]) {
		assert.deepEqual(risky(command), ["database"], command);
	}
	for (const command of [
		"psql $DATABASE_URL -c 'SELECT count(*) FROM users'",
		"npx prisma generate",
		"npx prisma migrate status",
		"php artisan migrate:status",
		"npx knex migrate:status",
		"rails db:migrate:status",
		"redis-cli GET key",
		"python manage.py shell",
	]) {
		assert.deepEqual(risky(command), [], command);
	}
});

test("destructive local commands, with temp and build dirs exempt", () => {
	for (const command of [
		"rm -rf src/old",
		"rm -rf ~/Work/pi-modes",
		"rm -fr build-output",
		"git reset --hard HEAD~1",
		"git clean -fd",
		"git branch -D feat/old",
		"git tag -d v0.1.0",
		"chmod -R 777 .",
		"chown -R me:staff /srv",
		"docker compose down -v",
		"docker system prune -af",
		"docker rm -f api",
	]) {
		assert.deepEqual(risky(command), ["destructive"], command);
	}
	for (const command of [
		"rm -rf /tmp/pds-e2e /tmp/pds-e2e-sessions",
		"rm -rf /private/tmp/x",
		"rm -rf $TMPDIR/foo",
		"rm -rf \"$(mktemp -d)\"",
		"rm -rf node_modules dist .cache",
		"rm -rf packages/web/node_modules",
		"rm -rf /private/tmp/a /tmp/b 2>/dev/null; echo cleaned",
		"rm -rf /tmp/x > /dev/null 2>&1",
		"rm file.txt",
		"rm -f a.log",
		"git reset HEAD~1",
		"git clean -n",
		"git branch -d merged",
		"docker ps",
		"docker compose up -d",
	]) {
		assert.deepEqual(risky(command), [], command);
	}
});

test("compound commands report every risky segment", () => {
	assert.deepEqual(risky("npm publish && git push origin main --tags"), ["release", "release"]);
	assert.deepEqual(risky("rm -rf /tmp/x && rm -rf src/legacy && git status"), ["destructive"]);
	assert.deepEqual(risky("sudo -E rm -rf /var/www/app"), ["destructive"]);
});

test("strings and heredoc bodies of local scripts are not commands", () => {
	assert.deepEqual(risky("echo 'rm -rf src && git push --force'"), []);
	assert.deepEqual(risky("python3 - <<'PY'\nimport os\nos.system('echo rm -rf src')\nPY"), []);
	assert.deepEqual(risky("grep -rn 'git push origin main' docs"), []);
});

test("tokenize and extractHeredocs", () => {
	assert.deepEqual(tokenize(`ssh -p 22 host 'a b' "c d" e\\ f`), ["ssh", "-p", "22", "host", "a b", "c d", "e f"]);
	const { stripped, bodies } = extractHeredocs("ssh h <<'EOF'\nsystemctl restart x\nEOF\necho done");
	assert.deepEqual(bodies, ["systemctl restart x"]);
	assert.match(stripped, /echo done/);
	assert.doesNotMatch(stripped, /systemctl/);
});

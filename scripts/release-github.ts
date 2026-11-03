// Releases @katrix/server and @katrix/client on GitHub instead of a package registry. For each
// package whose version has no release yet, it builds the package, takes the files `npm pack`
// would publish, and pushes them as one commit to a branch of this repository ("server",
// "client") with a tag per version ("server-0.4.0"). Users install with
// `npm install github:k18k/katrix#server` (latest) or `#server-0.4.0` (pinned): npm downloads that
// commit as a tarball, and no registry account or token is involved on either side.
//
// The built package.json has no scripts and no devDependencies: npm runs `prepare` for git
// dependencies (with the devDependencies installed), but the build is already done, and the
// sources it would need are not on the branch.
//
// Run by the Release workflow through changesets/action, which passes CHANGESETS_OUTPUT: each
// released package is reported there as a "git-tag" event, and the action then tags the source
// commit (@katrix/server@0.4.0) and creates the GitHub release from CHANGELOG.md.
//
// `node scripts/release-github.ts --dry-run` builds and commits the trees locally but pushes
// nothing (CI runs it on every change).

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGES = [
  { dir: "packages/server", branch: "server" },
  { dir: "packages/client", branch: "client" },
];

const root = fileURLToPath(new URL("..", import.meta.url));
const dryRun = process.argv.includes("--dry-run");
const bot = { name: "github-actions[bot]", email: "41898282+github-actions[bot]@users.noreply.github.com" };
const identity = {
  GIT_AUTHOR_NAME: bot.name,
  GIT_AUTHOR_EMAIL: bot.email,
  GIT_COMMITTER_NAME: bot.name,
  GIT_COMMITTER_EMAIL: bot.email,
};

function run(cmd: string, args: string[], options: { cwd?: string; env?: Record<string, string> } = {}): string {
  return execFileSync(cmd, args, {
    cwd: options.cwd ?? root,
    env: { ...process.env, ...options.env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
}

const git = (args: string[], options?: { cwd?: string; env?: Record<string, string> }) => run("git", args, options);

/** The commit a ref of origin points to, or undefined when origin has no such ref. */
function remoteRef(ref: string): string | undefined {
  const line = git(["ls-remote", "origin", ref])
    .split("\n")
    .find((l) => l.endsWith(`\t${ref}`));
  return line?.split("\t")[0];
}

const gitDir = git(["rev-parse", "--absolute-git-dir"]);
const source = git(["rev-parse", "HEAD"]);
let failed = false;

for (const { dir, branch } of PACKAGES) {
  const manifest = JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8")) as { name: string; version: string };
  const { name, version } = manifest;
  const tag = `${branch}-${version}`;

  if (remoteRef(`refs/tags/${tag}`) && !dryRun) {
    console.log(`${name}@${version}: already released (tag ${tag})`);
    continue;
  }

  const stage = mkdtempSync(join(tmpdir(), `katrix-${branch}-`));
  try {
    run("npm", ["run", "build"], { cwd: join(root, dir) });
    // The tarball is the only file in the fresh stage directory (`npm pack --json` changed shape
    // between npm versions, so its output is not parsed).
    run("npm", ["pack", "--ignore-scripts", "--pack-destination", stage], { cwd: join(root, dir) });
    const tarball = readdirSync(stage).find((f) => f.endsWith(".tgz"));
    if (!tarball) throw new Error("npm pack wrote no tarball");
    run("tar", ["-xzf", join(stage, tarball), "-C", stage]);
    const tree = join(stage, "package");

    const pkg = JSON.parse(readFileSync(join(tree, "package.json"), "utf8"));
    delete pkg.scripts;
    delete pkg.devDependencies;
    delete pkg.publishConfig;
    writeFileSync(join(tree, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);

    // A separate index, so the checkout's own index and working tree stay untouched; -f because
    // the built files (dist/) match the repository's .gitignore.
    const env = { GIT_INDEX_FILE: join(stage, "index") };
    git(["--git-dir", gitDir, "--work-tree", tree, "add", "-A", "-f", "."], { cwd: tree, env });
    const treeId = git(["--git-dir", gitDir, "--work-tree", tree, "write-tree"], { cwd: tree, env });

    // Each release commit has the previous one as parent, so the branch reads as the release history.
    const parents: string[] = [];
    if (!dryRun && remoteRef(`refs/heads/${branch}`)) {
      git(["fetch", "--no-tags", "--depth=1", "origin", `refs/heads/${branch}`]);
      parents.push("-p", git(["rev-parse", "FETCH_HEAD"]));
    }
    const message = `${name} ${version}\n\nBuilt from ${source}.`;
    const commit = git(["commit-tree", treeId, ...parents, "-m", message], { env: identity });

    const files = git(["ls-tree", "-r", "--name-only", commit]).split("\n").length;
    if (dryRun) {
      console.log(`${name}@${version}: built ${commit} (${files} files); would push branch ${branch} and tag ${tag}`);
      continue;
    }

    git(["push", "--atomic", "origin", `${commit}:refs/heads/${branch}`, `${commit}:refs/tags/${tag}`]);
    console.log(`${name}@${version}: pushed ${commit} (${files} files) to branch ${branch} and tag ${tag}`);
    console.log(`  npm install github:k18k/katrix#${tag}`);
    if (process.env.CHANGESETS_OUTPUT) {
      const event = { type: "git-tag", tag: `${name}@${version}`, packageName: name };
      appendFileSync(process.env.CHANGESETS_OUTPUT, `${JSON.stringify(event)}\n`);
    }
  } catch (err) {
    console.error(`${name}@${version}: release failed: ${(err as Error).message}`);
    failed = true;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

if (failed) process.exit(1);

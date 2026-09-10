/* What this machine remembers between runs.
 *
 * TWO FILES, AND THE SPLIT MATTERS.
 *
 *   ~/.aloic/config.json    the key, which belongs to the person
 *   ./.aloic                the project, which belongs to the directory
 *
 * A key is per machine: signing in once should mean every project on this
 * computer can be deployed. Which project a folder publishes to is a fact
 * about the folder, so it lives beside it and can be committed, which is what
 * lets a whole team deploy the same repository without each of them choosing
 * from a list every time.
 *
 * THE KEY FILE IS 0600. It is the only secret this tool holds, and a
 * world-readable secret in a home directory is how shared machines leak.
 * Everything here also yields to environment variables, because a build
 * machine has no home directory worth writing to and no browser to sign in
 * with. */

import { chmod, mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";

const DIR = process.env.ALOIC_HOME || join(homedir(), ".aloic");
const FILE = join(DIR, "config.json");
const PROJECT_FILE = ".aloic";

async function readJson(path) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch { return null; }
}

export async function loadConfig() {
  return (await readJson(FILE)) || {};
}

export async function saveConfig(patch) {
  const now = { ...(await loadConfig()), ...patch };
  await mkdir(DIR, { recursive: true });
  await writeFile(FILE, JSON.stringify(now, null, 2) + "\n", { mode: 0o600 });
  /* Set explicitly as well as on create, because a file that already existed
     keeps whatever mode it had. */
  await chmod(FILE, 0o600).catch(() => {});
  return now;
}

export async function clearConfig() {
  await unlink(FILE).catch(() => {});
}

export const configPath = () => FILE;

/* The key, from wherever it is. The environment wins over the file so a build
   machine and a laptop can run the same command and mean different things.

   ALOIC_DEPLOY_KEY still answers, because it was the name first and a rename
   that breaks somebody's pipeline is not a rename, it is an outage. */
export async function findKey() {
  for (const name of ["ALOIC_KEY", "ALOIC_DEPLOY_KEY"]) {
    const env = process.env[name];
    if (env && env.trim()) return { key: env.trim(), from: name };
  }
  const cfg = await loadConfig();
  if (cfg.key) return { key: cfg.key, from: configPath() };
  return null;
}

/* ---------- the project a folder publishes to ---------- */

/* Walked upward from the working directory, the way every tool that keeps a
   dotfile does, so running the command from a subfolder still finds it. */
export async function findProject(from = process.cwd()) {
  let at = resolve(from);
  for (;;) {
    const got = await readJson(join(at, PROJECT_FILE));
    if (got?.project) return { ...got, file: join(at, PROJECT_FILE) };
    const up = dirname(at);
    if (up === at) return null;
    at = up;
  }
}

export async function saveProject(dir, project, slug) {
  const file = join(resolve(dir), PROJECT_FILE);
  await writeFile(
    file,
    JSON.stringify({ project, slug }, null, 2) + "\n"
  );
  return file;
}

/* What to call the key this machine makes, so a list of them in a browser is
   a list of places rather than a list of "Untitled". */
export function deviceName() {
  const host = (hostname() || "").split(".")[0];
  return (host || "Terminal").slice(0, 60);
}

/* Replacing this tool with a newer copy of itself.
 *
 * WHY THIS IS ALLOWED TO EXIST NOW. The note next door in update.mjs says a
 * deploy tool that changes its own version by itself cannot be reasoned about,
 * and that is still true of a tool that does it without being asked. What
 * changed is that it is a setting somebody chose during setup, and it is only
 * ever honoured where the answer is obviously safe:
 *
 *   NEVER IN A PIPELINE. No terminal means a build machine, and a build
 *   machine that quietly moves to a version nobody pinned is the exact failure
 *   the old note was written about.
 *
 *   NEVER MID-COMMAND. It runs after the work is finished, so the deploy that
 *   just happened was done by the version that was asked for, and the new one
 *   takes over on the next run.
 *
 *   NEVER OVER SOMEBODY ELSE'S INSTALL. If these files are not under
 *   ~/.aloic/versions then something else owns them, npm or a checkout, and
 *   quietly writing into it would be a worse bug than being out of date.
 *
 * The mechanics are exactly what install.sh does, in Node: read the manifest,
 * fetch each file, check it against its published hash, and only once every
 * one of them is verified move the whole directory into place and swing the
 * `current` link at it. A failure at any point leaves the version that is
 * running exactly where it was. */

import { createHash } from "node:crypto";
import { mkdir, rm, writeFile, symlink, unlink, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const GET = process.env.ALOIC_GET || "https://get.aloic.ai";

const dir = () => process.env.ALOIC_HOME || join(homedir(), ".aloic");

/* Whether this copy is one the installer put here, which is the only kind we
   are entitled to replace. */
export function installed() {
  try {
    const here = resolve(fileURLToPath(import.meta.url), "..", "..");
    return here.startsWith(resolve(dir(), "versions") + sep);
  } catch { return false; }
}

const sha256 = buf => createHash("sha256").update(buf).digest("hex");

/* Fetch, verify, stage, swap. Returns the version installed. */
export async function installVersion(version) {
  const r = await fetch(`${GET}/manifest.json`, { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error("Could not read the release manifest.");
  const man = await r.json();
  if (man?.version !== version) {
    throw new Error(`${version} is not the published release (${man?.version}).`);
  }
  if (!Array.isArray(man.files) || !man.files.length) {
    throw new Error("The release manifest is empty.");
  }

  const stage = join(dir(), `.staging-${process.pid}`);
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });

  try {
    for (const f of man.files) {
      if (typeof f?.path !== "string" || !/^[a-zA-Z0-9._/-]+$/.test(f.path)
        || f.path.includes("..")) {
        throw new Error("The release manifest names a file it should not.");
      }
      const hit = await fetch(`${GET}/${version}/${f.path}`,
        { signal: AbortSignal.timeout(20_000) });
      if (!hit.ok) throw new Error(`Could not download ${f.path}.`);
      const body = Buffer.from(await hit.arrayBuffer());
      if (sha256(body) !== f.sha256) {
        throw new Error(`${f.path} did not match its published hash.`);
      }
      const at = join(stage, f.path);
      await mkdir(dirname(at), { recursive: true });
      await writeFile(at, body);
    }

    const target = join(dir(), "versions", version);
    await mkdir(join(dir(), "versions"), { recursive: true });
    await rm(target, { recursive: true, force: true });
    /* The move is the moment it becomes real, and it happens only after every
       byte has been checked. */
    const { rename } = await import("node:fs/promises");
    await rename(stage, target);

    /* THE LINK IS SWUNG LAST. The launcher runs whatever `current` points at,
       so until this line the running version is still the one on disk and a
       failure above changes nothing at all. */
    const link = join(dir(), "current");
    await unlink(link).catch(() => {});
    await symlink(target, link);
    return version;
  } finally {
    await rm(stage, { recursive: true, force: true }).catch(() => {});
  }
}

/* What the installer published, or null if it cannot be reached. */
export async function latest() {
  try {
    const r = await fetch(`${GET}/latest`, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return null;
    const v = (await r.text()).trim();
    return /^\d+\.\d+\.\d+/.test(v) ? v : null;
  } catch { return null; }
}

/* Whether the files sitting in `current` are byte for byte the ones the
   manifest publishes. Cheap: a dozen small files hashed locally, one request.
   Any missing or altered file answers false, which is the honest answer for
   "is this install the release it claims to be". */
export async function matches(version) {
  try {
    const r = await fetch(`${GET}/manifest.json`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return true;               /* cannot tell, so do not churn */
    const man = await r.json();
    if (man?.version !== version || !Array.isArray(man.files)) return true;
    const at = join(dir(), "current");
    const { readFile } = await import("node:fs/promises");
    for (const f of man.files) {
      const body = await readFile(join(at, f.path)).catch(() => null);
      if (!body || sha256(body) !== f.sha256) return false;
    }
    return true;
  } catch { return true; }
}

/* Whether the directory we would write into is actually ours to write into. */
export async function writable() {
  try { await stat(join(dir(), "versions")); return true; }
  catch { return false; }
}

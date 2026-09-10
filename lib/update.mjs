/* Telling somebody a newer version exists.
 *
 * QUIETLY, ONCE A DAY, AND NEVER IN THE WAY. An update notice is the smallest
 * feature in a tool and the easiest one to make hateful: check on every run and
 * you have added a network round trip to a deploy; check loudly and you have
 * put a banner between somebody and the output they ran the command for; check
 * blocking and one slow registry response makes the whole tool feel broken.
 *
 * So: at most once a day, after the work is done, on a socket that is allowed
 * to fail, and never at all when nobody is watching. A build machine has no use
 * for this and its logs should not carry it.
 *
 * IT NEVER UPDATES ANYTHING BY ITSELF. A deploy tool that changes its own
 * version mid-pipeline is a deploy tool that cannot be reasoned about. It says
 * what to run and leaves the decision where it belongs. */

import { homedir } from "node:os";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { saveConfig } from "./config.mjs";
import { box, c, out, tty } from "./ui.mjs";

/* WHERE THE RELEASES ACTUALLY ARE. This asked the npm registry, and there is
   no `aloic` package on it: the check ran, quietly found nothing, and reported
   nothing, forever. The releases are hosted by us at get.aloic.ai, which is
   also what the one line installer reads, so the tool and the installer agree
   about what the current version is by reading the same file. */
const GET = process.env.ALOIC_GET || "https://get.aloic.ai";

/* HOW THIS COPY GOT HERE, so the suggestion is the one that will work.
   Installed by the script, the files live under ~/.aloic/versions and the way
   to upgrade is to run it again. Anywhere else it came through npm. */
function viaInstaller() {
  try {
    const here = resolve(fileURLToPath(import.meta.url), "..", "..");
    return here.startsWith(resolve(homedir(), ".aloic") + sep);
  } catch { return false; }
}

/* Newer, by the ordinary three number comparison, ignoring any prerelease
   suffix: somebody on a release candidate asked for it and does not need to be
   told about the stable one. */
function newer(a, b) {
  const nums = v => String(v).split("-")[0].split(".").map(n => parseInt(n, 10) || 0);
  const [x, y] = [nums(a), nums(b)];
  for (let i = 0; i < 3; i++) {
    if ((x[i] || 0) > (y[i] || 0)) return true;
    if ((x[i] || 0) < (y[i] || 0)) return false;
  }
  return false;
}

export async function checkForUpdate(version) {
  if (!tty() || process.env.ALOIC_NO_UPDATE_CHECK) return null;
  try {
    /* EVERY TIME, NOT ONCE A DAY.
     *
     * This was cached for twenty-four hours, which is the right shape for a
     * notice printed after the work and the wrong one for a notice printed
     * before it: somebody who updates and then runs a command should not be
     * told for the rest of the day that they are out of date, and somebody on
     * a build from last week should be told on the first command rather than
     * whenever the cache happens to lapse.
     *
     * It costs one request for a file of eight bytes, and the whole thing is
     * abandoned after two seconds. `checkedAt` and `latest` are still written
     * so anything reading them keeps working. */
    const r = await fetch(`${GET}/latest`, { signal: AbortSignal.timeout(2000) });
    if (!r.ok) return null;
    const latest = (await r.text()).trim();
    if (!/^\d+\.\d+\.\d+/.test(latest)) return null;
    void saveConfig({ checkedAt: Date.now(), latest }).catch(() => {});
    return newer(latest, version) ? latest : null;
  } catch {
    /* Never a reason to say anything. */
    return null;
  }
}

/* THE NOTICE ITSELF, IN A FRAME.
 *
 * It is the one thing this tool prints that is not about the command somebody
 * ran, and it used to be a grey line among the grey lines of a deploy, which
 * is where a notice goes to be scrolled past. See the note on box() for why a
 * border does the work here that another sentence could not.
 *
 * WHAT IT TELLS SOMEBODY TO RUN DEPENDS ON HOW THEY GOT IT. `aloic update`
 * only replaces an install this tool made; over an npm copy or a checkout it
 * has nothing to write to, so those are told the command that will actually
 * work rather than the one that reads best. */
export function tellAboutUpdate(latest, version, how = null) {
  if (!latest) return;
  const run = how || (viaInstaller()
    ? "curl -fsSL https://get.aloic.ai | sh"
    : "npm i -g aloic");
  out("");
  box([
    `${c.grey(version)} ${c.grey("\u2192")} ${c.bold(c.yellow(latest))}`,
    `Run ${c.bold(c.cyan(run))} to install it.`
  ], { title: "Update available", tone: "yellow" });
}

/* Signing a terminal in.
 *
 * THE DEVICE AUTHORIZATION SHAPE, and it is the only one that fits. A terminal
 * cannot receive an email, and asking somebody to paste an account password
 * into a command is how passwords end up in shell history. So the tool makes a
 * request, opens a browser at it, and waits; the browser is already signed in,
 * shows what is being asked for in words, and approves.
 *
 * THE TERMINAL HOLDS A SECRET THE BROWSER NEVER SEES. The request carries only
 * the hash of it. That is what stops somebody who reads the link over your
 * shoulder from collecting the key: they can approve the request, and the key
 * still goes only to the process that can prove it made it.
 *
 * NO LOCAL WEB SERVER, and that is worth saying because it is the usual way to
 * do this. A callback server means binding a port, which fails on locked down
 * machines, breaks over SSH, and puts the tool's security on a socket anyone
 * on the box can talk to. Polling an endpoint has none of those problems and
 * works identically over SSH, in a container, and on a laptop. */

import { randomBytes, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { API, PROJECT } from "./api.mjs";
import { deviceName } from "./config.mjs";

const FS = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

const rand = n => randomBytes(n).toString("base64url").slice(0, n);
const sha256 = s => createHash("sha256").update(s).digest("hex");

/* The browser that will do the approving. Opened rather than printed when
   there is one, printed as well as opened always: a link that only exists
   inside a window that failed to open is a dead end, and this runs over SSH
   often enough for that to matter. */
export function openBrowser(url) {
  const cmd = process.platform === "darwin" ? "open"
    : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export async function startLogin(web) {
  const rid = rand(24);
  const token = rand(32);
  const expiresAt = Date.now() + 10 * 60_000;

  /* Created unauthenticated, which the rules allow because the document is
     worth nothing on its own: a device name, the hash of a secret, and an
     expiry. See cliRequests in firestore.rules. */
  const r = await fetch(`${FS}/cliRequests?documentId=${rid}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      fields: {
        tokenHash: { stringValue: sha256(token) },
        device: { stringValue: deviceName() },
        createdAt: { integerValue: String(Date.now()) },
        expiresAt: { integerValue: String(expiresAt) }
      }
    })
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`Could not start sign in. ${body.slice(0, 200)}`);
  }

  /* THROUGH THE CONSOLE, NOT STRAIGHT AT THE APPROVAL PAGE.
     Setting a terminal up is an authenticated act, and /dashboard is the door
     that establishes a real session: arriving there signed out runs the
     ordinary sign-in and comes back here, so by the time the approval screen
     appears the browser is signed in exactly as it is for everything else.
     Pointing at /auth directly skipped that and made this the one flow in the
     product with its own idea of what being signed in means. */
  return { rid, token, expiresAt, url: `${web}/dashboard/cli?code=${rid}` };
}

/* Asked for repeatedly until somebody approves it, which is what the 202 is
   for: waiting is the expected answer, not a failure, and it must not read
   like one in a log. */
export async function awaitApproval({ rid, token, expiresAt }, onTick) {
  for (;;) {
    if (Date.now() > expiresAt) throw new Error("That sign in expired. Run it again.");
    const r = await fetch(`${API}/api/signin/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cli: rid, token })
    });
    if (r.status === 200) {
      const got = await r.json();
      /* Refused in the browser. Thrown with a name the caller can recognise,
         because "cancelled" deserves different words and different choices
         from "the network failed". */
      if (got.status === "denied") {
        /* CLOSING THE TAB IS NOT THE SAME AS PRESSING CANCEL. One is a
           decision and the other is usually an accident, and the way back
           from them is different: a decision deserves a menu, a closed tab
           deserves the setup opening again. */
        const no = new Error(got.closed
          ? "The setup tab was closed."
          : "Authentication cancelled.");
        no.cancelled = true;
        no.closed = got.closed === true;
        throw no;
      }
      return got;
    }
    if (r.status === 202) {
      /* WHICH KIND OF WAITING. "waiting" is nobody has looked at the browser
         yet; "setup" is they approved it and are choosing how the tool should
         work. The caller shows a different line for each, because a spinner
         that says the same thing through both is a spinner that never
         acknowledged the thing the person just did. */
      const st = await r.json().then(b => b?.status, () => null);
      onTick?.(st || "waiting");
      /* Two seconds. Fast enough that approving feels immediate, slow enough
         that a browser left open for ten minutes is three hundred requests
         rather than thirty thousand. */
      await new Promise(s => setTimeout(s, 2000));
      continue;
    }
    const body = await r.json().catch(() => ({}));
    const why = {
      expired: "That sign in expired. Run it again.",
      "not-yours": "That request belongs to another terminal.",
      unknown: "That request no longer exists. Run it again."
    }[body.error] || `Sign in failed (${r.status}).`;
    throw new Error(why);
  }
}

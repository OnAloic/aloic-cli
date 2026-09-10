#!/usr/bin/env node
/* aloic — publish a folder to Aloic.
 *
 *   aloic login              sign this machine in through a browser
 *   aloic init               choose which project this folder publishes to
 *   aloic deploy ./dist      publish it
 *
 * THE THREE COMMANDS ARE ONE COMMAND. Running `aloic deploy` with nothing set
 * up does the login and the project choice on the way past, because a tool
 * that stops to tell you to run two other commands first has simply moved the
 * work onto the person. Each step is still available on its own for the cases
 * where somebody wants to do them deliberately.
 *
 * EXIT CODES MATTER HERE more than in most tools: this runs unattended, and a
 * pipeline decides whether a deploy worked by asking this process. Zero means
 * the site is live. Anything else means it is not, and the reason is on stderr
 * in one line that names what to do about it. */

import { readFile, writeFile, rm, rmdir, stat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { signIn, have, putBlob, putMap, publish, revoke, hashOf, keyOf } from "./lib/api.mjs";
import { walk, read, typeOf, tooMuch } from "./lib/files.mjs";
import {
  findKey, findProject, saveProject, loadConfig, saveConfig, clearConfig,
  configPath, deviceName
} from "./lib/config.mjs";
import { startLogin, awaitApproval, openBrowser } from "./lib/login.mjs";
import { checkForUpdate, tellAboutUpdate } from "./lib/update.mjs";
import { c, out, ok, info, bad, bar, pick, ask, secret, spin, tty, confirm } from "./lib/ui.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(
  await readFile(resolve(here, "package.json"), "utf8")
).version;

const WEB = process.env.ALOIC_WEB || "https://aloic.ai";

/* ---------- how this copy of the tool behaves ----------
 *
 * CHOSEN IN THE BROWSER DURING SETUP, kept in the same file as the key, and
 * changeable afterwards with `aloic settings`. Three, and every one of them is
 * honoured somewhere below: a setting that does nothing is worse than no
 * setting, because it teaches people the screen is decoration.
 *
 * The defaults are what the tool did before any of this existed, so an
 * existing install that has never seen the setup screen behaves identically. */
const DEFAULTS = {
  /* Whether `aloic deploy` points the project at what it just uploaded, or
     keeps it as a draft for somebody to publish deliberately. */
  publish: true,
  /* Whether it asks first. Off, because a deploy tool that stops to ask on
     every run is a deploy tool people wrap in `yes |`. */
  confirm: false,
  /* What to do about a newer version: install it after the command finishes,
     or say nothing until `aloic update` is run. Never automatic without a
     terminal, whatever this says: see lib/selfupdate.mjs. */
  updates: "auto"
};

/* The three questions, in the words the setup screen in the browser uses. Both
   places ask the same thing; a tool and its setup page disagreeing about what
   a setting is called is how somebody ends up with two mental models of one
   switch. */
const SETTINGS = [
  {
    key: "publish",
    q: "When you run aloic deploy",
    on: "Publish it",
    off: "Save it as a draft",
    /* Shown under the answer, because the thing worth knowing about choosing
       to publish is that the other behaviour is still one flag away. */
    note: "You can still run aloic deploy --draft any time to save the deployment as a draft."
  },
  {
    key: "confirm",
    q: "Before publishing",
    on: "Ask me first",
    off: "Publish immediately"
  },
  {
    key: "updates",
    q: "New versions",
    on: "Update automatically",
    off: "Only notify me",
    /* These two are words rather than true and false, because "false" for an
       update setting reads as "never" and this one means "when you say so". */
    values: ["auto", "ask"]
  }
];

async function settings() {
  const cfg = await loadConfig();
  return { ...DEFAULTS, ...(cfg.settings || {}) };
}

const args = process.argv.slice(2);
const cmd = (args[0] || "").replace(/^-+/, "") || "";
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};
const has = name => args.includes(`--${name}`);

const die = (s, code = 1) => { process.stderr.write(`${c.red("✗")} ${s}\n`); process.exit(code); };

const HELP = `${c.bold("aloic")} ${c.grey(VERSION)}  publish a folder to Aloic

${c.bold("Commands")}
  login                sign this machine in through your browser
  logout               revoke this machine's key and forget it
  settings             change how this machine's CLI behaves
  update               move to the newest version
  uninstall            remove the CLI and everything it wrote
  init                 choose which project this folder publishes to
  deploy [folder]      publish a folder and point the project at it
  deploy draft         publish the draft this project is holding
  test draft           open the draft at a temporary address
  projects             list the projects this machine can publish to
  whoami               show who this machine is signed in as

${c.bold("Options")}
  --title <text>       names the deploy, shown as its heading
  --description <text> what changed, shown under the name
  --project <slug>     publish to this project, ignoring .aloic
  --draft              upload without pointing the project at it
  --publish            publish it, whatever the saved setting says
  --keep-key           uninstall without removing the saved key
  --quiet              print only the address at the end
  --version            print the version and exit

${c.grey("Unattended, set ALOIC_KEY and skip login entirely.")}`;

/* ---------- signing in ---------- */

async function sessionOrLogin({ quiet } = {}) {
  const found = await findKey();
  if (found) return await signIn(found.key);

  if (!tty()) {
    die("Not signed in. Set ALOIC_KEY, or run `aloic login` on a machine with a browser.");
  }
  if (!quiet) {
    out("");
    info("This machine is not signed in yet.");
  }
  /* This one goes on to publish, so it needs the session and not just the
     key. See the note on `session` in login. */
  return await login({ silent: true, session: true });
}

/* `session` says whether the caller needs a signed-in session back, or only
   needs the machine set up. Setting up and having a session are not the same
   thing: `aloic login` finishes the moment the key is saved, while `deploy`
   needs to go on and use it. Exchanging the key for a session regardless meant
   a round trip after the success line was already printed, so a bad minute on
   the network produced a green tick followed by a crash. */
async function login({ silent, bare, session } = {}) {
  /* IS THERE ANYTHING AT THE OTHER END. Signing in means opening a page and
     waiting for somebody to press a button on it, so a web app that is not
     answering produces the worst possible failure: a browser tab showing an
     error, a spinner in the terminal, and ten minutes until the request
     expires. One HEAD request before any of that turns it into a sentence.

     Not fatal on its own: a machine behind a proxy that blocks HEAD, or with
     no route out at all while the browser has one, should not be stopped by
     our own reachability check. It says what it saw and carries on. */
  const reachable = await fetch(WEB, {
    method: "HEAD",
    redirect: "follow",
    signal: AbortSignal.timeout(4000)
  }).then(r => r.ok, () => false);
  if (!reachable) {
    out("");
    bad(`${WEB} is not answering.`);
    info("Signing in needs the Aloic web app, which approves the request.");
    info("Set ALOIC_WEB if you are running it somewhere else, or use a key:");
    out(`    ${c.grey("ALOIC_KEY=alo_... aloic deploy ./dist")}`);
    out("");
  }

  const ask = await startLogin(WEB);

  out("");
  out(`  ${c.bold("Sign in to Aloic")}`);
  out("");
  out(`  ${c.grey("Opening")} ${c.cyan(ask.url)}`);
  out("");
  out(`  ${c.grey("Approve the request for")} ${c.bold(deviceName())} ${c.grey("in your browser.")}`);
  out("");
  openBrowser(ask.url);

  /* THE WAIT CHANGES CHARACTER WHEN THEY PRESS ALLOW, and the line has to say
     so. Until then this is waiting on a decision; after it, the decision is
     made and the browser is asking how the tool should behave, which is a
     different thing to be told to go and do. */
  const s = spin("Waiting for you to approve it");
  let phase = "waiting";
  let got;
  try {
    got = await awaitApproval(ask, st => {
      if (st === "setup" && phase !== "setup") {
        phase = "setup";
        s.set("Setting up Aloic");
        s.say("Continue in your browser to finish setting up.");
      }
    });
    s.stop();
  } catch (e) {
    s.stop();
    /* CANCELLED IS NOT AN ERROR, it is a decision, and the two deserve
       different words and different exits. Somebody who meant to cancel does
       not need a red cross and a stack of advice; somebody who cancelled by
       accident needs the way back to be one keypress rather than remembering
       the command. */
    /* A CLOSED TAB IS ONE KEYPRESS FROM BEING OPEN AGAIN. Everything needed
       to try is still true: the account, the machine, the intent. A menu here
       would be three choices where there is one obvious one. */
    if (e.closed) return await afterClosed({ silent, bare, session });
    if (e.cancelled) return await afterCancel({ silent, bare, session });
    die(e.message);
  }

  /* The choices made in the browser arrive with the key and are written down
     beside it, so the first command after this already behaves the way the
     setup screen said it would. Defaults for anything that flow did not
     answer, which is every sign in from before it existed. */
  await saveConfig({
    key: got.key,
    email: got.email || "",
    savedAt: Date.now(),
    settings: { ...DEFAULTS, ...(got.settings || {}) }
  });

  if (phase === "setup") {
    ok("Aloic CLI was successfully set up.");
    /* THE COMMAND THAT WORKS FROM WHERE THEY ARE. Somebody who came here
       straight from the installer is standing in a shell whose PATH has not
       caught up, and telling them to run `aloic` is how the installer used to
       send people to "no such file or directory".

       Not said at all when this WAS `aloic`: the list of commands is printed
       underneath a moment later, so telling them to run the thing they just
       ran to see the thing they are about to see is noise. */
    if (!bare) {
      info(onPath()
        ? "Run `aloic` to see what it can do."
        : "Open a new terminal and run `aloic` to see what it can do.");
    }
  } else {
    ok(`Signed in as ${c.bold(got.email || got.name || "your account")}`);
    info(`Key saved to ${configPath()}, named ${deviceName()}`);
  }
  if (!silent) out("");
  return session ? await signIn(got.key) : null;
}

/* Whether the short name resolves in the shell this is running in. Used only
   to choose between two sentences. */
function onPath() {
  const dirs = String(process.env.PATH || "").split(":");
  return dirs.includes(join(homedir(), ".local", "bin"));
}

/* What happens when the setup tab goes away without an answer.
 *
 * Not the cancel menu: closing a window is rarely a decision about signing in,
 * and offering to paste a key by hand as one of three equal options is a menu
 * about the wrong thing. One line, one key, and the browser opens again. */
async function afterClosed(opts = {}) {
  out("");
  bad("The setup tab was closed.");
  if (!tty()) process.exit(1);
  out("");
  await ask(`  ${c.grey("Press")} ${c.bold("Enter")} ${c.grey("to reopen setup")}`);
  return await login({ ...opts, silent: true });
}

/* What happens after somebody presses Cancel in the browser. */
async function afterCancel(opts = {}) {
  out("");
  bad("Authentication cancelled.");
  out("");
  if (!tty()) process.exit(1);

  const choice = await pick(`  ${c.grey("What now?")}`, [
    { k: "retry", t: "Try signing in again" },
    { k: "paste", t: "Paste a terminal key instead" },
    { k: "quit", t: "Quit" }
  ], x => x.t);

  if (choice.k === "quit") process.exit(1);
  if (choice.k === "retry") return await login({ ...opts, silent: true });

  out("");
  info(`Make one in Settings on ${WEB}, then paste it here.`);
  const key = await secret(`  ${c.bold("Key")}`);
  if (!/^alo_[A-Za-z0-9_-]{32,64}$/.test(key)) {
    die("That does not look like a terminal key. They start with alo_.");
  }
  const who = await signIn(key).catch(() => die("That key was not accepted."));
  await saveConfig({ key, email: who.email || "", savedAt: Date.now() });
  ok(`Signed in as ${c.bold(who.email || "your account")}`);
  return who;
}

/* ---------- choosing a project ---------- */

const label = s => {
  const live = s.status === "live" ? c.green("live") : c.grey(s.status || "draft");
  return `${s.name || s.slug}  ${c.grey(s.primaryDomain || `${s.slug}.aloic.ai`)}  ${live}`;
};

async function chooseProject(who, { save = true, dir = process.cwd() } = {}) {
  if (!who.sites?.length) {
    die(`No projects on this account yet. Make one at ${WEB}/dashboard/projects/new`);
  }

  const named = flag("project");
  if (named) {
    /* THE NAME THIS TOOL ITSELF PRINTS HAS TO WORK. It listed "Test Project",
       asked for a slug, and then refused "Test Project": three behaviours that
       only make sense if you already know the two are different things.
       Matched case insensitively on either, and the error lists what was
       actually on offer rather than leaving somebody to remember a command. */
    const want = named.trim().toLowerCase();
    const hit = who.sites.find(s =>
      s.slug.toLowerCase() === want
      || s.id === named
      || (s.name || "").trim().toLowerCase() === want);
    if (!hit) {
      die(`No project called "${named}" on this account. Yours are:\n`
        + who.sites.map(s => `  ${s.slug}${s.name && s.name !== s.slug ? `  (${s.name})` : ""}`).join("\n"));
    }
    return hit;
  }

  const saved = await findProject(dir);
  if (saved) {
    const hit = who.sites.find(s => s.id === saved.project);
    if (hit) return hit;
    info(`${saved.file} names a project this key cannot reach. Choose again.`);
  }

  const chosen = await pick(
    `  ${c.bold("Which project?")}`, who.sites, label,
    list => `No terminal to choose with. Pass --project, for example:\n`
      + `  aloic deploy ${args[1] && !args[1].startsWith("--") ? args[1] : "."}`
      + ` --project ${list[0].slug}`
  );
  if (save) {
    const file = await saveProject(dir, chosen.id, chosen.slug);
    info(`Remembered in ${file}. Commit it and the whole team deploys the same project.`);
  }
  return chosen;
}

/* ---------- commands ---------- */

async function cmdLogin() {
  const found = await findKey();
  if (found && !has("force")) {
    const who = await signIn(found.key).catch(() => null);
    if (who) {
      ok(`Already signed in${who.sites?.length ? ` with ${who.sites.length} project${who.sites.length === 1 ? "" : "s"}` : ""}.`);
      info("Run `aloic login --force` to sign in again.");
      return;
    }
  }
  await login({});
}

async function cmdLogout() {
  const found = await findKey();
  if (!found) { ok("Not signed in on this machine."); return; }

  /* A KEY FROM THE ENVIRONMENT IS NOT THIS MACHINE'S TO REVOKE. It was put
     there by a pipeline or a shell profile, other machines may be using the
     same one, and deleting it on the way out of an unrelated command would
     take a deployment pipeline down. Only the one `login` saved is revoked. */
  if (found.from !== configPath()) {
    await clearConfig();
    ok("Signed out on this machine.");
    info(`The key in ${found.from} is left alone. Revoke it in Settings on aloic.ai.`);
    return;
  }

  const who = await signIn(found.key).catch(() => null);
  const gone = who ? await revoke(found.key, who.idToken).catch(() => false) : false;
  await clearConfig();

  if (gone) {
    ok("Terminal key revoked.");
    info("Run `aloic login` to sign in again.");
  } else {
    ok("Signed out on this machine.");
    info("The key could not be revoked from here. Remove it in Settings on aloic.ai.");
  }
}

/* ---------- taking it back off ----------
 *
 * EVERY INSTALLER OWES YOU ONE. A tool that writes to three places in your
 * home directory and a line into your shell profile, and then has no way to
 * undo any of it, is a tool you have to clean up by hand from a blog post. It
 * is also the thing that makes the install worth trusting: an install you can
 * reverse in one command is an install you can try.
 *
 * There is a shell version of this in the installer as well, for the case this
 * one cannot help with, which is a copy too broken to run. */
async function cmdUninstall() {
  const dir = process.env.ALOIC_HOME || join(homedir(), ".aloic");
  const launcher = join(homedir(), ".local", "bin", "aloic");
  const keepKey = has("keep-key");

  /* Was this copy put here by the installer, or is it npx running out of a
     cache somewhere? Only the first case owns the directories below. */
  const mine = here.startsWith(resolve(dir) + sep);

  const targets = [];
  const seen = async p => { try { await stat(p); return true; } catch { return false; } };
  if (await seen(join(dir, "versions"))) targets.push(join(dir, "versions"));
  if (await seen(join(dir, "current"))) targets.push(join(dir, "current"));
  /* The file the installer writes for `source ~/.aloic/env`. Left behind, it
     is one stale line pointing at a directory that no longer has anything in
     it, and it keeps the directory from being tidied away. */
  if (await seen(join(dir, "env"))) targets.push(join(dir, "env"));
  if (await seen(launcher)) targets.push(launcher);

  if (!targets.length && !mine) {
    out("");
    info("This copy was not installed by the Aloic installer, so there is nothing here to remove.");
    info("If you installed it with npm, remove it with `npm rm -g aloic`.");
    if (await seen(configPath())) {
      out("");
      info(`Your saved key is still at ${configPath()}. Remove it with \`aloic logout\`.`);
    }
    return;
  }

  out("");
  out(`  ${c.bold("Uninstall Aloic")}`);
  out("");
  for (const t of targets) out(`  ${c.grey("remove")} ${t}`);
  if (!keepKey && await seen(configPath())) {
    out(`  ${c.grey("remove")} ${configPath()} ${c.grey("(your saved key)")}`);
  }
  out(`  ${c.grey("remove")} the PATH line from your shell profile ${c.grey("(if it is there)")}`);
  out("");

  /* IT ASKS, AND WHERE IT CANNOT ASK IT REFUSES.

     Every other command in this tool treats "no terminal" as "get on with it",
     which is right for publishing and wrong for deleting: a command that
     removes the tool, the key and a line from a shell profile must not do that
     because it happened to be run from a script. With nobody to answer, the
     answer has to be on the command line. */
  if (!has("yes")) {
    if (!tty()) {
      die("Uninstalling needs a terminal to confirm from. Pass --yes to skip the question.");
    }
    if (!await confirm("  Are you sure you want to uninstall the Aloic CLI?", false)) {
      out("");
      info("Nothing was removed.");
      return;
    }
  }

  /* TWO STEPS, NAMED, IN THE ORDER THEY HAPPEN.

     Signing out is a network round trip and deleting files is not, so without
     saying which one is running the whole thing is a pause followed by a tick.
     They are also genuinely different acts: the first gives a credential back
     to the server, the second takes files off this machine, and somebody
     watching should be able to tell which one failed. */
  out("");

  /* THE KEY GOES BACK FIRST, while there is still a tool to do it with. A
     local file deleted is a key that goes on working on the server, listed in
     Settings, until somebody notices it. Best effort: being offline is not a
     reason to refuse to uninstall. */
  if (!keepKey) {
    const found = await findKey();
    if (found && found.from === configPath()) {
      const s1 = tty() ? spin("Logging out") : null;
      const who = await signIn(found.key).catch(() => null);
      const gone = who ? await revoke(found.key, who.idToken).catch(() => false) : false;
      s1?.stop();
      if (gone) ok("Terminal key revoked.");
      else info("The key could not be revoked from here. Remove it in Settings on aloic.ai.");
    } else if (found) {
      info(`The key in ${found.from} is left alone. Revoke it in Settings on aloic.ai.`);
    }
    await clearConfig();
  }

  const s2 = tty() ? spin("Uninstalling") : null;
  for (const t of targets) await rm(t, { recursive: true, force: true }).catch(() => {});
  /* Only if it is empty. Somebody may keep other things in here, and an
     uninstaller that takes a directory it did not create is a bug. */
  await rmdir(dir).catch(() => {});

  const rc = await stripPath();
  s2?.stop();

  ok("Aloic removed.");
  if (rc) info(`The PATH line was taken out of ${rc}. Open a new terminal.`);
  else info("Nothing was left in your shell profile.");
  out("");
  out(`  ${c.grey("Install it again with")} ${c.cyan("curl -fsSL https://get.aloic.ai | sh")}`);
  out("");
}

/* The two lines the installer appended, and only those two. Rewritten rather
   than truncated, so anything somebody added afterwards survives. */
async function stripPath() {
  const files = [".zshrc", ".bashrc", ".bash_profile", ".profile",
    join(".config", "fish", "config.fish")];
  for (const name of files) {
    const at = join(homedir(), name);
    let text;
    try { text = await readFile(at, "utf8"); } catch { continue; }
    if (!text.includes("# aloic installer")) continue;
    const next = text.replace(
      /\n*# aloic installer\n(?:export PATH=[^\n]*\n|fish_add_path[^\n]*\n)?/g,
      "\n"
    );
    if (next === text) continue;
    await writeFile(at, next);
    return at;
  }
  return null;
}

/* ---------- changing them later ----------
 *
 * The setup screen in the browser is where these are first chosen, and a
 * choice you can only revisit by signing in again is a choice you will live
 * with instead. Same three questions, asked the way a terminal asks them. */
async function cmdSettings() {
  const now = await settings();
  const vals = s => s.values || [true, false];
  const label = (s, v) => (v === vals(s)[0] ? s.on : s.off);

  if (!tty()) {
    out("");
    for (const s of SETTINGS) {
      out(`  ${c.grey(s.q.padEnd(28))}${label(s, now[s.key])}`);
    }
    out("");
    info("Run this in a terminal to change them.");
    return;
  }

  out("");
  const next = { ...now };
  for (const s of SETTINGS) {
    const chosen = await pick(
      `  ${c.bold(s.q)}`,
      vals(s).map(v => ({ v, t: label(s, v) })),
      it => (it.v === now[s.key] ? `${it.t} ${c.grey("(current)")}` : it.t)
    );
    next[s.key] = chosen.v;
    /* The footnote belongs to an ANSWER, not to the question, so it appears
       only for the person it is about. */
    if (s.note && chosen.v === vals(s)[0]) info(c.grey(s.note));
  }
  await saveConfig({ settings: next });
  out("");
  ok("Saved.");
  info(`Stored in ${configPath()}`);
}

/* ---------- moving to a newer version ----------
 *
 * The manual half of the update setting. Somebody who chose "update when I
 * ask" needs something to ask with, and somebody on automatic still wants a
 * way to do it now rather than after the next command. */
async function cmdUpdate() {
  const { installed, installVersion, latest, writable, matches } =
    await import("./lib/selfupdate.mjs");

  if (!installed() || !await writable()) {
    out("");
    info("This copy was not installed by the Aloic installer, so it cannot update itself.");
    info("Reinstall with: curl -fsSL https://get.aloic.ai | sh");
    return;
  }

  const s = tty() ? spin("Checking for a newer version") : null;
  const v = await latest();
  s?.stop();

  if (!v) { bad("Could not reach get.aloic.ai."); process.exit(1); }

  /* "ALREADY ON IT" HAS TO MEAN THE FILES ARE THE ONES PUBLISHED, not that a
     number matches. A release that was overwritten in place, which happened
     once and is now refused at the packing end, leaves an install with the
     right version number and the wrong contents, and a check that compares
     only the number can never get it out of that. This compares what is on
     disk against the manifest and repairs it when they differ. */
  if (v === VERSION && await matches(v)) {
    ok(`Already on ${c.bold(VERSION)}.`);
    return;
  }
  if (v === VERSION) info("This copy does not match the published release. Repairing.");

  const s2 = tty() ? spin(`Updating to ${v}`) : null;
  try {
    await installVersion(v);
    s2?.stop();
    ok(`Updated ${c.grey(VERSION)} ${c.grey("\u2192")} ${c.bold(v)}`);
  } catch (e) {
    s2?.stop();
    bad(e?.message || "That update did not go through.");
    info(`Still on ${VERSION}. Nothing was changed.`);
    process.exit(1);
  }
}

async function cmdWhoami() {
  const who = await sessionOrLogin({ quiet: true });
  const from = (await findKey())?.from;
  out(`${c.bold(who.email || "signed in")}`);
  out(`${c.grey("key from")} ${from}`);
  out(`${c.grey("projects")} ${who.sites?.length || 0}`);
}

async function cmdProjects() {
  const who = await sessionOrLogin({ quiet: true });
  if (!who.sites?.length) return info("No projects on this account yet.");
  /* The slug is what --project wants, and three unlabelled columns left
     somebody guessing which of them that was. */
  const wide = Math.max(...who.sites.map(s => (s.name || s.slug).length));
  out(`  ${c.grey("NAME".padEnd(wide))}  ${c.grey("--project")}`);
  for (const s of who.sites) {
    const live = s.status === "live" ? c.green("live") : c.grey(s.status || "draft");
    out(`  ${(s.name || s.slug).padEnd(wide)}  ${c.bold(s.slug)}  ${live}`);
  }
}

async function cmdInit() {
  const who = await sessionOrLogin({});
  const chosen = await chooseProject(who, { save: true });
  /* WRITTEN HERE TOO, and this is the fix for a real lie. chooseProject only
     saves the choice it had to ASK for, so `aloic init --project x` returned a
     green tick, wrote nothing, and the very next deploy prompted again. An
     init that does not persist is worse than one that fails, because it fails
     one command later and somewhere else. */
  const file = await saveProject(process.cwd(), chosen.id, chosen.slug);
  ok(`This folder publishes to ${c.bold(chosen.name || chosen.slug)}.`);
  info(`Written to ${file}. Commit it and the whole team deploys the same project.`);
}

async function cmdDeploy() {
  /* `aloic deploy draft` is the finish of the sentence `aloic deploy --draft`
     started, so it is spelled the way the earlier command printed it. The
     keyword wins over a folder of the same name: deploying a directory called
     exactly "draft" is vanishingly rare and still one character away as
     `aloic deploy ./draft`, whereas the keyword silently deploying a folder
     would publish the wrong thing without saying so. */
  if (args[1] === "draft") return await cmdDraft("publish");

  const quiet = has("quiet");
  /* THE CLOCK STARTS WHEN THE WORK DOES, not when the command was typed.

     This was set here, above the sign in, the project picker and the prompt
     for a title, so every second somebody spent reading a list or thinking of
     a name was billed to the deploy: a build that took four seconds reported
     forty because the person answering the prompt was slow, and that number is
     stored on the record and shown in the deploy list forever.

     Nothing above the first note is work. It is a conversation. */
  let began = Date.now();
  const log = [];
  const note = (m, k) => {
    log.push({ at: Date.now() - began, m, ...(k ? { k } : {}) });
    if (!quiet) out(k === "step" ? `\n${c.bold(m)}` : `  ${c.grey(m)}`);
  };

  const where = resolve(args[1] && !args[1].startsWith("--") ? args[1] : ".");

  const who = await sessionOrLogin({ quiet });

  /* WHAT THIS MACHINE WAS TOLD TO DO, and the flags still win.
     --draft and --publish are one command saying what it wants; the setting is
     what every command means when it says nothing. */
  const prefs = await settings();
  const live = has("publish") ? true : has("draft") ? false : prefs.publish !== false;

  const site = await chooseProject(who, { save: live });

  /* REQUIRED. A deploy with no name is a row in a list that says "Upload", and
     a list of those is a history nobody can read, which is most of the reason
     to keep a history. Asked for until it is answered when somebody is there;
     refused outright when nobody is, because a pipeline that publishes
     anonymous builds is the case this is for. */
  /* `--message` still answers. It was the name first, and the GitHub Action
     people have already copied into their repositories passes it: a rename
     that breaks somebody's pipeline is not a rename, it is an outage. */
  let title = (flag("title") || flag("message") || "").trim();
  if (!title) {
    if (!tty()) {
      die("This deploy needs a title. Pass --title \"what this is\".");
    }
    out("");
    while (!title) {
      title = await ask(`  ${c.bold("Title")}`, "Name this deployment.");
      if (!title) info("A title is needed.");
    }
  }

  /* ASKED BEFORE ANYTHING MOVES, for whoever asked to be asked. After the
     title, so the question names the thing it is about, and before the upload,
     because stopping half way through one is not a decision anybody wanted to
     have offered to them. */
  /* WHERE THERE IS NOBODY TO ASK, IT DOES NOT ASK.
     This used to refuse and name a flag. Confirming before publishing is a
     personal preference somebody set on their own machine, not a safety rail
     the product depends on, and a preference that stops a build machine is a
     preference that has escaped its scope. Deleting things still asks: see
     cmdUninstall, which refuses precisely because it is not a preference. */
  if (live && prefs.confirm && tty()) {
    const where = site.primaryDomain || `${site.slug}.aloic.ai`;
    out("");
    if (!await confirm(`  Publish to ${c.bold(where)}?`)) {
      out("");
      info("Nothing was uploaded.");
      return;
    }
  }

  /* Everything above was somebody answering questions. Time starts here. */
  began = Date.now();

  note("Reading files", "step");
  const { files, skipped } = await walk(where);
  const wrong = tooMuch(files);
  if (wrong) die(wrong);
  const bytes = files.reduce((n, f) => n + f.size, 0);
  note(`${files.length} ${files.length === 1 ? "file" : "files"}, ${(bytes / 1024).toFixed(0)}KB`);
  if (skipped.length) {
    note(`${skipped.length} not included: ${skipped.slice(0, 3).join(", ")}${skipped.length > 3 ? "…" : ""}`);
  }

  /* EVERYTHING IS HASHED FIRST, then compared against what is already stored,
     and only what is missing goes up. On a second deploy of a site whose
     images did not change, that is the difference between sending the whole
     build and sending the one file that was edited. */
  const blobs = new Map();
  const map = {};
  for (const f of files) {
    const buf = await read(f);
    f.hash = hashOf(buf);
    map[keyOf(f.path)] = f.hash;
    if (!blobs.has(f.hash)) blobs.set(f.hash, { buf, type: typeOf(f.path) });
  }

  const already = await have(who.uid, site.id, who.idToken);
  const todo = [...blobs.entries()].filter(([h]) => !already.has(h));
  const reused = blobs.size - todo.length;

  note("Uploading", "step");
  if (reused) note(`${reused} already stored, not sent again`);

  let sent = 0, failed = null, at = 0;
  const s = todo.length && !quiet && tty() ? spin("") : null;
  const paint = () => s?.set(`${bar(sent, todo.length)} ${sent}/${todo.length}`);
  paint();

  /* Four at a time. Enough to keep a connection busy, few enough that a
     failure is reported before much more has been spent on it. */
  await Promise.all(Array.from({ length: Math.min(4, todo.length) }, async () => {
    for (;;) {
      if (failed) return;
      const item = todo[at++];
      if (!item) return;
      const [hash, { buf, type }] = item;
      try { await putBlob(who.uid, site.id, who.idToken, hash, type, buf); }
      catch (e) { failed = e; return; }
      sent++; paint();
    }
  }));
  s?.stop();
  if (failed) die(`Upload failed. ${failed.message}`);
  note(`Sent ${todo.length} ${todo.length === 1 ? "file" : "files"} in ${((Date.now() - began) / 1000).toFixed(1)}s`);

  /* THE ID ALOIC ALREADY PICKED, when there is one.
   *
   * A build started from the dashboard creates the deploy record first, so
   * there is a page to watch from the moment the button is pressed, and passes
   * its id to the workflow. Filling that record in is the difference between
   * one deploy that goes from building to ready and two rows where one of them
   * says "building" forever.
   *
   * Only ever from the environment, and only a shape we would have generated
   * ourselves: this decides which document gets written, and the write is
   * scoped to this project by the key either way. A push-triggered build sends
   * nothing and makes its own, exactly as before. */
  const given = String(process.env.ALOIC_DEPLOYMENT || "").trim();
  const deployId = /^[A-Za-z0-9_-]{16,32}$/.test(given)
    ? given
    : randomBytes(15).toString("base64url");
  await putMap(who.uid, site.id, who.idToken, deployId, map);

  /* SAID OUT LOUD, because it is a change to the files somebody just gave us
     and finding it by curling your own site is the wrong way to learn it. */
  note("Aloic adds a small analytics script to served HTML pages", "info");

  if (live) {
    note("Publishing", "step");
    note(`Pointing ${site.primaryDomain || `${site.slug}.aloic.ai`} at this deploy`);
  } else {
    note("Uploaded", "step");
    note("Not published. The project keeps serving what it was.");
  }

  await publish(who.idToken, site.id, deployId, {
    id: deployId,
    siteId: site.id,
    uid: who.uid,
    status: "ready",
    files: files.length,
    bytes,
    createdAt: began,
    ms: Date.now() - began,
    root: "",
    skipped: skipped.length,
    /* THE MESSAGE NAMES THE DEPLOY. It is the commit subject in a pipeline and
       the one line somebody writes by hand otherwise, which is a name rather
       than a description, and it is what the deploy page shows as its
       heading. --description is the longer form underneath. */
    title: title.slice(0, 120),
    note: (flag("description") || "").trim().slice(0, 500),
    /* Says it was never published, which is not the same as having been
       replaced. See the note on `draft` in lib/creators.ts. */
    ...(live ? {} : { draft: true }),
    expiresAt: null,
    log,
    /* Says where it came from, so a deploy page can tell a push from a drop. */
    via: "cli"
  }, live);

  const url = `https://${site.primaryDomain || `${site.slug}.aloic.ai`}`;
  const took = c.grey(`${((Date.now() - began) / 1000).toFixed(1)}s`);
  if (quiet) out(live ? url : deployId);
  else {
    out("");
    /* A DRAFT IS NOT LIVE, and saying so would be the one lie this tool tells.
       It printed the address either way, which read as a successful publish of
       something that was deliberately not published. */
    if (live) ok(`Live at ${c.cyan(url)}  ${took}`);
    else {
      ok(`Draft created  ${took}`);
      info(`Your previous deployment is still published at ${c.cyan(url)}.`);
      /* WHAT TO DO WITH IT, NAMED. A draft is the one deploy that is not
         finished with, and a tool that makes one and then says nothing about
         how to look at it or send it leaves somebody in the dashboard hunting
         for a button. Two commands, both of which act on this draft. */
      out("");
      out(`  ${c.grey("Preview it in a browser")}`);
      out(`    ${c.bold("aloic test draft")}`);
      out("");
      out(`  ${c.grey(`Publish it to ${url}`)}`);
      out(`    ${c.bold("aloic deploy draft")}`);
    }
  }
}

/* ---------- finishing with a draft ----------
 *
 * TWO ENDINGS FOR ONE THING, and they are the two sentences the deploy that
 * made it printed: look at it, or send it. Both act on the newest draft of
 * whichever project this folder publishes to, because that is what somebody
 * means by "the draft" one command after making one.
 */
async function cmdDraft(what) {
  const who = await sessionOrLogin({});
  const site = await chooseProject(who, { save: false });

  const { newestDraft, publishDraft, setPreview, PREVIEW_FOR } =
    await import("./lib/api.mjs");

  /* NOT CAUGHT AND FLATTENED TO null. A failed lookup and an empty project are
     different facts, and reporting the first as the second is how a broken
     query spent a release telling people they had no draft when they were
     looking at one. */
  const s0 = tty() ? spin("Looking for a draft") : null;
  let d = null;
  try {
    d = await newestDraft(who.idToken, site.id);
    s0?.stop();
  } catch (e) {
    s0?.stop();
    die(e?.message || "Could not look for a draft.");
  }

  if (!d) {
    out("");
    bad(`${site.name || site.slug} has no draft waiting.`);
    info("Make one with `aloic deploy --draft`.");
    process.exit(1);
  }

  const name = (d.title || d.note || "").trim() || d.id.slice(0, 8);
  const url = `https://${site.primaryDomain || `${site.slug}.aloic.ai`}`;

  if (what === "publish") {
    out("");
    out(`  ${c.bold(name)} ${c.grey(`${d.files} files, ${(d.bytes / 1024).toFixed(0)}KB`)}`);
    out("");

    /* THE SAME SETTING THE UPLOAD PATH READS. Somebody who asked to be asked
       before publishing meant every publish, not only the ones that happen to
       come with an upload attached. */
    const prefs = await settings();
    if (prefs.confirm && tty()) {
      if (!await confirm(`  Publish to ${c.bold(url.replace(/^https:\/\//, ""))}?`)) {
        out("");
        info("Nothing was published.");
        return;
      }
      out("");
    }

    const s = tty() ? spin("Publishing") : null;
    try {
      await publishDraft(who.idToken, site.id, d.id);
      s?.stop();
    } catch (e) {
      s?.stop();
      die(e?.message || "That draft could not be published.");
    }
    ok(`Live at ${c.cyan(url)}`);
    return;
  }

  /* ---------- test ----------
   *
   * A preview is a whole host of its own rather than a path, so an absolute
   * link inside the build resolves inside the preview: see previewUrl in
   * src/lib/creators.ts. It is minted here and stopped when this command
   * ends, so the address lives exactly as long as somebody is looking at it. */
  const key = previewName();
  const until = Date.now() + PREVIEW_FOR;
  const s = tty() ? spin("Making a preview") : null;
  try {
    await setPreview(who.idToken, site.id, d.id, key, until);
    s?.stop();
  } catch (e) {
    s?.stop();
    die(e?.message || "That preview could not be made.");
  }

  const at = `https://${key}--${site.slug}.aloic.ai`;
  out("");
  ok(`Previewing ${c.bold(name)}`);
  out(`  ${c.cyan(at)}`);
  out("");
  openBrowser(at);

  if (!tty()) {
    info(`This address stops answering in ${PREVIEW_FOR / 60000} minutes.`);
    return;
  }

  /* THE CLOCK IS THE POINT. A preview that quietly expires is a link somebody
     sends and then has to explain; one that counts down in front of you is a
     thing you know the shape of. Enter ends it early. */
  const ring = spin("", "");
  const tick = () => {
    const left = Math.max(0, until - Date.now());
    const m = Math.floor(left / 60000), sec = Math.floor((left % 60000) / 1000);
    ring.set(`Preview open for ${c.bold(`${m}:${String(sec).padStart(2, "0")}`)}`);
    ring.say("Press Enter to stop the preview.");
  };
  tick();
  const beat = setInterval(tick, 1000);

  await Promise.race([
    ask(""),
    new Promise(r => setTimeout(r, Math.max(0, until - Date.now())))
  ]);
  clearInterval(beat);
  ring.stop();

  /* Ended deliberately rather than left to run out, which is the difference
     between a link that is dead and a link that is dead in half an hour. */
  await setPreview(who.idToken, site.id, d.id, key, 0).catch(() => {});
  ok("Preview stopped.");
}

/* Lowercase and digits, because a host is case insensitive and a deploy id is
   not. Random, so a preview cannot be guessed from an id anybody can list. */
function previewName() {
  return randomBytes(9).toString("hex").slice(0, 12);
}

/* ---------- running ---------- */

if (has("version") || cmd === "version") { out(VERSION); process.exit(0); }

const commands = {
  login: cmdLogin, logout: cmdLogout, whoami: cmdWhoami,
  projects: cmdProjects, init: cmdInit, deploy: cmdDeploy,
  settings: cmdSettings, update: cmdUpdate, uninstall: cmdUninstall,
  test: () => cmdDraft("test")
};
const run = commands[cmd];

/* ---------- `aloic`, on its own ----------
 *
 * IT CHECKS WHETHER IT IS SET UP, which is what makes it the one thing the
 * installer has to tell anybody to run. Bare, with no key on this machine, the
 * useful thing is not a list of commands that will all refuse: it is the setup
 * that makes them work. With a key, it is the list.
 *
 * Only ever with no arguments at all. `aloic deploy` on an unconfigured
 * machine already asks for a sign-in on its way past, and `aloic --help` is
 * somebody asking for the list rather than for anything to happen. */
if (!cmd && !has("help")) {
  const already = await findKey();
  if (!already) {
    await login({ silent: true, bare: true });
    out("");
    out(HELP);
    process.exit(0);
  }
}

/* A COMMAND NOBODY HAS IS NOT A REQUEST FOR THE MANUAL.
 *
 * Every unrecognised word printed the whole help page, which reads as though
 * the command worked and this is its output: the one line saying it was not
 * understood is the first thing scrolled off the top by the forty lines
 * underneath it. Say the one thing that is true and point at the list. */
if (cmd && !run && cmd !== "help") {
  out("");
  bad(`We didn't recognize that command.`);
  info("Run `aloic` to see all available commands.");
  process.exit(1);
}

if (!run || has("help") || cmd === "help") {
  out(HELP);
  process.exit(0);
}

/* The update check runs beside the command rather than before it, so a slow
   lookup cannot delay a deploy, and is only ever reported at the end.

   NOT WHILE UNINSTALLING, and this was a real leak rather than an ordering
   nicety. The check records when it last ran by writing to the same config
   file the uninstaller has just deleted, so the two raced and the write
   usually landed second: every uninstall left a config.json behind in a
   directory it had otherwise emptied, and the next install found a stale
   record of a check that happened before the tool was removed. Telling
   somebody about a new version of the thing they are in the middle of removing
   would be beside the point anyway. */
/* ---------- new versions ----------
 *
 * CHECKED BEFORE THE COMMAND RUNS, not after it.
 *
 * It used to be a line printed once the work was done, once a day, which is
 * the polite version and the wrong one: the moment somebody most wants to know
 * they are on an old build is before it does anything, not underneath the
 * output of something that has already happened. So it is asked every time and
 * said first.
 *
 * WHAT KEEPS THAT FROM BEING A TAX ON EVERY DEPLOY. It is one request for a
 * file of eight bytes, it is given two seconds and then abandoned, and it does
 * not happen at all without a terminal: a build machine gets no notice, no
 * delay and no behaviour that depends on the network being reachable.
 *
 * The commands about the tool itself are excluded, because being told an
 * update exists while running the thing that installs updates is the tool
 * talking to itself. */
const quiet0 = cmd === "uninstall" || cmd === "settings" || cmd === "update";
let newer = null;
if (!quiet0 && tty()) {
  const prefs0 = await settings().catch(() => DEFAULTS);
  /* `false` is what the first version of this setting stored for "do not
     check". Nothing writes it any more and honouring it is one comparison:
     silently starting to check for somebody who once said not to would be
     changing a decision on their behalf. */
  if (prefs0.updates !== "off" && prefs0.updates !== false) {
    newer = await checkForUpdate(VERSION).catch(() => null);
    /* Said before anything else, and only for the mode that asked to be told.
       On automatic there is nothing to act on: it installs itself below. */
    if (newer && prefs0.updates !== "auto") {
      const { installed } = await import("./lib/selfupdate.mjs");
      tellAboutUpdate(newer, VERSION, installed() ? "aloic update" : null);
    }
  }
}

try {
  await run();
  await afterwards(newer);
} catch (e) {
  die(e?.message || String(e));
}

/* WHAT TO DO ABOUT A NEWER VERSION, once the work is done.
 *
 * On automatic it installs it here rather than before the command, so the
 * thing that just ran is the version that was asked for and the new one takes
 * over next time. Failing is not worth a red cross on an otherwise successful
 * deploy: it says so quietly and the tool goes on working. */
async function afterwards(newer) {
  if (!newer) return;
  const prefs = await settings().catch(() => DEFAULTS);
  /* Only automatic acts here. Notifying already happened, before the command,
     which is where it is worth reading. */
  if (prefs.updates !== "auto") return;

  const { installed, installVersion, writable } = await import("./lib/selfupdate.mjs");
  /* Never over an install we did not make, and never without somebody there:
     a pipeline moving itself to a version nobody pinned is the failure the
     note in lib/update.mjs is about. */
  if (!installed() || !await writable()) return tellAboutUpdate(newer, VERSION);

  try {
    await installVersion(newer);
    out("");
    info(`Updated to ${c.bold(newer)}. It takes effect on the next command.`);
  } catch {
    tellAboutUpdate(newer, VERSION);
  }
}

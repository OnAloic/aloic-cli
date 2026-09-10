/* The parts of a terminal that make a tool feel like a tool.
 *
 * NO DEPENDENCIES HERE EITHER. Every one of these is thirty lines of escape
 * codes that have worked since the 1970s, and taking a package for them means
 * a deploy tool that stops working when that package does.
 *
 * EVERYTHING DEGRADES. A pipe is not a terminal: there is no cursor to move,
 * no colour worth printing and nobody to press a key. Each of these checks and
 * falls back to plain lines, because the same command runs on a laptop and
 * inside a build machine and only one of those has a person watching. */

import { stdin, stdout } from "node:process";

const ESC = "";
export const tty = () => !!stdout.isTTY && !!stdin.isTTY;

/* Colour, unless something says otherwise. NO_COLOR is honoured because it is
   the one convention every tool agrees on, and FORCE_COLOR because CI logs are
   often colour capable while failing every other test for it. */
const plain = !!process.env.NO_COLOR
  || (!stdout.isTTY && process.env.FORCE_COLOR !== "1");
const wrap = (a, b) => s => (plain ? String(s) : `${ESC}[${a}m${s}${ESC}[${b}m`);
export const c = {
  bold: wrap(1, 22), dim: wrap(2, 22), under: wrap(4, 24),
  red: wrap(31, 39), green: wrap(32, 39), yellow: wrap(33, 39),
  blue: wrap(34, 39), grey: wrap(90, 39), cyan: wrap(36, 39)
};

export const out = s => stdout.write(s + "\n");

/* A step with a mark in front of it, so a transcript can be skimmed for the
   line that went wrong rather than read. */
export const ok = s => out(`${c.green("✓")} ${s}`);
export const bad = s => out(`${c.red("✗")} ${s}`);
export const info = s => out(`${c.grey("·")} ${s}`);

/* A spinner that knows it might not be watched. In a pipe it prints the label
   once and returns a no-op, so a build log gets one line instead of two
   hundred frames of animation. */
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼",
                "⠴", "⠦", "⠧", "⠇", "⠏"];
export function spin(label, note = "") {
  if (!tty()) {
    info(label);
    if (note) info(note);
    return { stop(final) { if (final) out(final); }, set() {}, say(n) { if (n) info(n); } };
  }
  let i = 0, text = label, under = note;

  /* A SECOND LINE UNDER THE RING, WITHOUT LOSING THE RING'S LINE.
   *
   * The spinner redraws itself with a carriage return, which only ever reaches
   * the line the cursor is on, so anything printed after it would be the line
   * the next frame overwrites. Drawing the note and then stepping back up one
   * row leaves the cursor where the ring lives: the note is written once per
   * frame and never moves, and the ring goes on turning above it.
   *
   * This exists because a spinner alone cannot say why it is spinning. Waiting
   * on somebody in a browser is a wait with an instruction attached, and the
   * instruction has to be visible for the whole of it. */
  const clear = () => {
    stdout.write(`\r${ESC}[2K`);
    if (under) stdout.write(`\n${ESC}[2K${ESC}[1A`);
  };
  const draw = () => {
    stdout.write(`\r${ESC}[2K${c.cyan(FRAMES[i++ % FRAMES.length])} ${text}`);
    if (under) stdout.write(`\n${ESC}[2K${c.grey(under)}${ESC}[1A`);
  };
  stdout.write(`${ESC}[?25l`);
  draw();
  const t = setInterval(draw, 80);
  return {
    set(s) { text = s; },
    /* Added or changed while it is running: the wait changes character when
       the browser hands over, and so does what somebody should be doing. */
    say(n) {
      /* Taking a note away has to erase the row it was on before the cursor
         stops visiting it. */
      if (under && !n) { stdout.write(`\n${ESC}[2K${ESC}[1A`); }
      under = n || "";
    },
    stop(final) {
      clearInterval(t);
      clear();
      stdout.write(`${ESC}[?25h`);
      if (final) out(final);
    }
  };
}

/* A progress bar for the one part of a deploy that takes real time. */
export function bar(done, total, width = 22) {
  const filled = total ? Math.round((done / total) * width) : width;
  return c.grey("[") + c.cyan("█".repeat(filled))
    + c.grey("░".repeat(Math.max(0, width - filled))) + c.grey("]");
}

/* ---------- a box ----------
 *
 * WHY A BOX AT ALL, when every other line this tool prints is a mark and a
 * sentence. Because this one is not about what the command is doing. Every
 * other line belongs to the deploy somebody asked for; the update notice
 * interrupts it to talk about the tool itself, and a line that reads like
 * output but is not output is the kind of thing people learn to skim past.
 * A frame says "this is an aside" before a word of it has been read, and it
 * says so in one glance rather than one sentence.
 *
 * MEASURED WITHOUT THE COLOUR. The whole thing is alignment, and a colour code
 * is several invisible bytes that String.length counts anyway: measure the
 * painted string and every right hand edge lands short by however much colour
 * that line happened to use.
 *
 * IT GIVES UP RATHER THAN WRAP. A frame narrower than the thing inside it is
 * worse than no frame, so in a small terminal the lines are simply printed. */

const CODES = new RegExp(ESC + "\\[[0-9;]*m", "g");
export const wide = s => String(s).replace(CODES, "").length;

export function box(lines, { title = "", tone = "yellow", pad = 2 } = {}) {
  const paint = c[tone] || (s => s);
  const rule = n => "─".repeat(Math.max(0, n));
  const inner = Math.max(wide(title) + 6, ...lines.map(l => wide(l) + pad * 2));

  /* Not enough room to draw one honestly, so do not draw one. */
  if ((stdout.columns || 80) < inner + 3) {
    if (title) out(c.bold(paint(title)));
    lines.filter(l => wide(l)).forEach(l => out(`  ${l}`));
    return;
  }

  /* The title sits in the top edge rather than on a line of its own: it is two
     words, and a whole row for two words is a taller box saying no more. */
  out(title
    ? paint("╭─ ") + c.bold(paint(title)) + " "
      + paint(rule(inner - 3 - wide(title)) + "╮")
    : paint("╭" + rule(inner) + "╮"));

  for (const line of lines) {
    out(paint("│") + " ".repeat(pad) + line
      + " ".repeat(inner - pad - wide(line)) + paint("│"));
  }

  out(paint("╰" + rule(inner) + "╯"));
}

/* ---------- asking ---------- */

const readKey = () => new Promise(resolve => {
  const onData = buf => {
    stdin.removeListener("data", onData);
    stdin.setRawMode(false);
    stdin.pause();
    resolve(buf.toString());
  };
  stdin.resume();
  stdin.setRawMode(true);
  stdin.once("data", onData);
});

/* PICK ONE, WITH ARROW KEYS, which is what makes a setup feel like a program
   rather than a form. It falls back to a numbered list when there is no
   terminal to drive, because the same command runs unattended.
 *
 * The list is redrawn in place rather than reprinted, and only a window of it
 * is drawn at all, so somebody with forty projects does not lose their shell
 * history to a menu. */
export async function pick(title, items, render = String, nudge = null) {
  if (!items.length) throw new Error("There is nothing to choose from.");
  if (items.length === 1) {
    out(`${title} ${c.cyan(render(items[0]))}`);
    return items[0];
  }

  if (!tty()) {
    /* THE ONE MESSAGE THAT FIRES EXACTLY WHEN SOMEBODY IS STUCK, so it names
       the flag and shows it being used with a real value from the list above.
       It used to say "name the project as an argument", which reads as a
       positional and is not: following it literally fails with this same
       message and no new information, which is a dead end with a signpost. */
    out(title);
    items.forEach(it => out(`  ${render(it)}`));
    throw new Error(nudge ? nudge(items) : "No terminal to choose from.");
  }

  const WINDOW = Math.min(items.length, 8);
  let at = 0, top = 0;

  const draw = first => {
    if (!first) stdout.write(`${ESC}[${WINDOW + 1}A`);
    stdout.write(`${ESC}[2K${title}\n`);
    for (let r = 0; r < WINDOW; r++) {
      const i = top + r;
      const on = i === at;
      const line = i < items.length
        ? `${on ? c.cyan("❯") : " "} ${on ? c.bold(render(items[i])) : render(items[i])}`
        : "";
      stdout.write(`${ESC}[2K${line}\n`);
    }
  };

  stdout.write(`${ESC}[?25l`);
  draw(true);
  for (;;) {
    const k = await readKey();
    /* Ctrl-C, by hand: raw mode swallows the signal, so a tool that reads keys
       has to honour it itself or it cannot be quit. */
    if (k === "") { stdout.write(`${ESC}[?25h`); out(""); process.exit(130); }
    if (k === "\r" || k === "\n") break;
    if (k === `${ESC}[A` || k === "k") at = (at - 1 + items.length) % items.length;
    else if (k === `${ESC}[B` || k === "j") at = (at + 1) % items.length;
    else continue;
    if (at < top) top = at;
    if (at >= top + WINDOW) top = at - WINDOW + 1;
    if (at === 0) top = 0;
    if (at === items.length - 1) top = Math.max(0, items.length - WINDOW);
    draw(false);
  }
  stdout.write(`${ESC}[?25h`);

  /* Leave the ANSWER on screen and take the menu away. A finished prompt that
     is still a menu is a transcript nobody can read afterwards. */
  stdout.write(`${ESC}[${WINDOW + 1}A${ESC}[2K${title} ${c.cyan(render(items[at]))}\n`);
  for (let r = 0; r < WINDOW; r++) stdout.write(`${ESC}[2K\n`);
  stdout.write(`${ESC}[${WINDOW}A`);
  return items[at];
}

export async function confirm(question, yes = true) {
  if (!tty()) return yes;
  stdout.write(`${question} ${c.grey(yes ? "[Y/n]" : "[y/N]")} `);
  for (;;) {
    const k = await readKey();

    /* THE FIRST CHARACTER THAT MEANS ANYTHING, not the first byte.
     *
     * This tested `k.toLowerCase().startsWith("y")`, and a keypress does not
     * reliably begin with the letter: a terminal can put an escape sequence in
     * front of it, a paste arrives wrapped in bracketed-paste markers, and a
     * pty can deliver a control byte glued to the character behind it. Every
     * one of those read as "neither yes nor no" and fell through to the
     * default, so on a question about deleting things somebody could type y,
     * watch it print "no", and be told nothing was removed. It is worth being
     * careful here in both directions: the same fall-through on a [Y/n]
     * question would have taken yes from noise.
     *
     * Control characters out, whitespace off, then look. */
    const said = k.replace(/[\u0000-\u001f\u007f]/g, "").trim().toLowerCase();

    if (said.startsWith("y")) { out("yes"); return true; }
    if (said.startsWith("n")) { out("no"); return false; }

    /* Ctrl-C and Ctrl-D both mean stop, and raw mode swallows both, so a tool
       that reads keys has to honour them itself or it cannot be quit. */
    if (!said && /[\u0003\u0004]/.test(k)) { out(""); process.exit(130); }
    /* Return on its own takes the default, which is exactly what the capital
       letter in the prompt promises. */
    if (!said && /[\r\n]/.test(k)) { out(yes ? "yes" : "no"); return yes; }
    /* Anything else is asked again rather than guessed at. */
  }
}

/* A line typed in, for the one question that cannot be a menu. Hidden while
   typing, because the answer is a secret and a key echoed into a terminal is a
   key in a screen recording. */
export async function secret(question) {
  if (!tty()) throw new Error("No terminal to type into.");
  stdout.write(question + " ");
  stdin.resume();
  stdin.setRawMode(true);
  let buf = "";
  for (;;) {
    const k = await new Promise(r => stdin.once("data", d => r(d.toString())));
    if (k === "\u0003") { stdin.setRawMode(false); stdin.pause(); out(""); process.exit(130); }
    if (k === "\r" || k === "\n") break;
    if (k === "\u007f" || k === "\b") { buf = buf.slice(0, -1); continue; }
    /* Anything that is not a printable run is an arrow key or worse. */
    if (/^[\x20-\x7e]+$/.test(k)) buf += k;
  }
  stdin.setRawMode(false);
  stdin.pause();
  out("");
  return buf.trim();
}

/* A line of ordinary text, echoed as it is typed. The counterpart to secret()
   for answers that are not secrets. */
export async function ask(question, hint) {
  if (!tty()) return "";
  if (hint) out(`  ${c.grey(hint)}`);
  stdout.write(question + " ");
  stdin.resume();
  stdin.setRawMode(true);
  let buf = "";
  for (;;) {
    const k = await new Promise(r => stdin.once("data", d => r(d.toString())));
    if (k === "\u0003") { stdin.setRawMode(false); stdin.pause(); out(""); process.exit(130); }
    if (k === "\r" || k === "\n") break;
    if (k === "\u007f" || k === "\b") {
      if (buf) { buf = buf.slice(0, -1); stdout.write("\b \b"); }
      continue;
    }
    if (/^[\x20-\x7e]+$/.test(k)) { buf += k; stdout.write(k); }
  }
  stdin.setRawMode(false);
  stdin.pause();
  out("");
  return buf.trim();
}

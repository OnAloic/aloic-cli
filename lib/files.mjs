/* Which files go up, and what they are called.
 *
 * The same rules the browser applies to a dropped folder, because a project
 * deployed from a terminal and the same project dropped into the dashboard
 * have to produce the same site. */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

/* Sized for where the files actually go, which today is a database rather
   than a bucket. A file is held as one base64 string, so the real ceiling is
   a third higher than these and the whole thing has to fit in a free tier. */
export const MAX_FILES = 400;
export const MAX_BYTES = 25 * 1024 * 1024;
export const MAX_ONE = 4 * 1024 * 1024;

const TYPES = {
  html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8", map: "application/json; charset=utf-8",
  txt: "text/plain; charset=utf-8", xml: "application/xml; charset=utf-8",
  svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  gif: "image/gif", webp: "image/webp", avif: "image/avif", ico: "image/x-icon",
  mp4: "video/mp4", webm: "video/webm", mp3: "audio/mpeg", wav: "audio/wav",
  woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf",
  wasm: "application/wasm", pdf: "application/pdf",
  webmanifest: "application/manifest+json"
};
export const typeOf = path =>
  TYPES[path.split(".").pop()?.toLowerCase() || ""] || "application/octet-stream";

/* NOT PART OF A BUILT SITE, and left behind without being counted as a
   problem. Dependencies and version control are the two that would otherwise
   blow past every limit above on the first attempt, and reporting them as
   "skipped" rather than refusing the deploy is the difference between a tool
   that works when pointed at a project root and one that lectures you. */
const SKIP_DIR = new Set([
  "node_modules", ".git", ".svn", ".hg", ".cache", ".next", ".nuxt",
  ".output", ".turbo", ".parcel-cache", ".vercel", ".netlify", ".firebase",
  "__pycache__", ".venv", "venv", ".idea", ".vscode", "coverage"
]);
const SKIP_FILE = /^(\.DS_Store|Thumbs\.db|npm-debug\.log.*|\.env(\..+)?)$/;

export async function walk(root) {
  const files = [];
  const skipped = [];

  async function into(dir) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIR.has(e.name)) { skipped.push(rel(full) + "/"); continue; }
        await into(full);
        continue;
      }
      if (!e.isFile()) continue;
      if (SKIP_FILE.test(e.name)) { skipped.push(rel(full)); continue; }
      const info = await stat(full);
      if (info.size > MAX_ONE) { skipped.push(`${rel(full)} (too large)`); continue; }
      files.push({ path: rel(full), size: info.size, full });
    }
  }
  const rel = full => relative(root, full).split(sep).join("/");

  const info = await stat(root).catch(() => null);
  if (!info) throw new Error(`There is no folder at ${root}`);
  if (info.isFile()) {
    /* A single file is a site too: index.html on its own is a page. */
    return { files: [{ path: root.split(sep).pop(), size: info.size, full: root }], skipped };
  }
  await into(root);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, skipped };
}

export const read = f => readFile(f.full);

export function tooMuch(files) {
  const bytes = files.reduce((n, f) => n + f.size, 0);
  if (!files.length) return "There are no files to publish in that folder.";
  if (files.length > MAX_FILES) {
    return `That is ${files.length} files and the limit is ${MAX_FILES}. Publish a built folder rather than a project root.`;
  }
  if (bytes > MAX_BYTES) {
    return `That is ${(bytes / 1048576).toFixed(1)}MB and the limit is ${MAX_BYTES / 1048576}MB.`;
  }
  return null;
}

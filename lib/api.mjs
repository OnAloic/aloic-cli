/* Everything this tool knows about the outside world.
 *
 * NO DEPENDENCIES, ANYWHERE IN THIS PACKAGE. A deploy tool is the one thing in
 * a pipeline that has to work on a machine nobody has looked at, on whatever
 * Node happens to be installed, months after it was written. Every dependency
 * is a chance for that to stop being true, and everything here is one fetch
 * and one hash, both of which Node has had built in since 18. */

import { createHash } from "node:crypto";

/* The same public configuration the web app ships. None of it is secret: it
   names the project and nothing more, and every path below is still gated by
   the database rules on whoever is signed in. */
export const API = process.env.ALOIC_API || "https://api.aloic.ai";
export const PROJECT = "aloicai";
export const WEB_KEY = "AIzaSyC0yD5S7ggmIOvaWQMCr5FxJ47aeWY4BrU";
export const RTDB = "https://aloicai-default-rtdb.firebaseio.com";
/* A document's RESOURCE NAME, which is what the commit API wants, not a URL.
   Passing the full https:// address is rejected with "lacks projects at index
   0", which is a confusing way of saying the same thing. */
const DOC = `projects/${PROJECT}/databases/(default)/documents`;

async function jsonOrThrow(r, what) {
  const text = await r.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* not json */ }
  if (!r.ok) {
    const why = body?.error?.message || body?.error || text.slice(0, 200) || r.statusText;
    throw new Error(`${what}: ${why}`);
  }
  return body;
}

/* A deploy key, exchanged for a session that can publish to one project and
   nothing else. See api/signin/token.js. */
export async function signIn(key) {
  const r = await fetch(`${API}/api/signin/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deploy: key })
  });
  const got = await jsonOrThrow(r, "Could not use that deploy key");

  const s = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${WEB_KEY}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: got.customToken, returnSecureToken: true })
    }
  );
  const session = await jsonOrThrow(s, "Could not start a session");
  return { ...got, idToken: session.idToken };
}

/* ---------- the file store ---------- */

/* Which blobs this project already holds. Shallow, so the answer is a list of
   names rather than every byte under them: this is the request that makes a
   second deploy send only what changed, and asking for it the ordinary way
   would download the entire site to find out its filenames.

   Failing here means uploading everything, which is correct and merely slower.
   It must never mean failing the deploy. */
export async function have(uid, siteId, idToken) {
  try {
    const r = await fetch(
      `${RTDB}/blobs/${uid}/${siteId}.json?shallow=true&auth=${encodeURIComponent(idToken)}`
    );
    if (!r.ok) return new Set();
    const body = await r.json();
    return new Set(body && typeof body === "object" ? Object.keys(body) : []);
  } catch {
    return new Set();
  }
}

export async function putBlob(uid, siteId, idToken, hash, type, bytes) {
  const r = await fetch(
    `${RTDB}/blobs/${uid}/${siteId}/${hash}.json?auth=${encodeURIComponent(idToken)}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ t: type, b: bytes.toString("base64") })
    }
  );
  await jsonOrThrow(r, `Could not store a file`);
}

/* The map goes down LAST, so a deploy id never resolves to a half written
   site: until this lands there is nothing pointing at any of it. */
export async function putMap(uid, siteId, idToken, deployId, map) {
  const r = await fetch(
    `${RTDB}/files/${uid}/${siteId}/${deployId}/__map.json?auth=${encodeURIComponent(idToken)}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(map)
    }
  );
  await jsonOrThrow(r, "Could not finish the deploy");
}

/* ---------- the record ---------- */

/* Firestore's REST shape wants every value tagged with its type. */
function val(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") {
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  if (Array.isArray(v)) return { arrayValue: { values: v.map(val) } };
  if (typeof v === "object") return { mapValue: { fields: fields(v) } };
  return { stringValue: String(v) };
}
const fields = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, val(v)]));

/* ONE COMMIT, so a site can never point at a deploy that has no record and a
   record can never be written without the site being pointed at it. The same
   guarantee the browser gets from a batched write. */
export async function publish(idToken, siteId, deployId, record, live) {
  const writes = [
    {
      update: {
        name: `${DOC}/sites/${siteId}/deployments/${deployId}`,
        fields: fields(record)
      }
    }
  ];
  if (live) {
    writes.push({
      update: {
        name: `${DOC}/sites/${siteId}`,
        fields: fields({ liveDeployId: deployId, status: "live", updatedAt: Date.now() })
      },
      updateMask: { fieldPaths: ["liveDeployId", "status", "updatedAt"] }
    });
  }
  const r = await fetch(
    `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents:commit`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${idToken}`
      },
      body: JSON.stringify({ writes })
    }
  );
  await jsonOrThrow(r, "Could not record the deploy");
}

/* REVOKING A KEY FROM THE MACHINE THAT HOLDS IT.
 *
 * The document is named by the hash of the key, and this machine has the key,
 * so it can work out the name without ever having been told it. Signing out
 * without this leaves a working credential on the account for a machine that
 * has forgotten it, which is the kind of thing nobody goes back and tidies.
 *
 * Best effort: a key that cannot be reached is still forgotten locally, and
 * the account page can always revoke it by hand. */
/* ---------- drafts ----------
 *
 * A draft is a build that was uploaded and deliberately not published, which
 * makes it the one deploy the terminal has to be able to find again later: you
 * made it in one command and you finish with it in another, possibly the next
 * morning. Everything here works on "the newest draft of this project",
 * because that is what somebody means when they say "the draft".
 *
 * Deployment records are world readable by rule, so this is an ordinary query
 * carrying the session for consistency rather than for permission. */
export async function newestDraft(idToken, siteId) {
  /* NO orderBy, AND THAT IS THE POINT.
   *
   * The obvious query is "where draft is true, newest first, limit one", and
   * Firestore refuses it: a filter on one field ordered by another needs a
   * composite index, which did not exist, so this failed with a 400 every
   * time. The caller caught it and said the project had no draft, which is the
   * worst kind of bug, a lie told confidently about somebody's data.
   *
   * An equality filter on its own needs only the automatic single-field index
   * and always works. A project has a handful of drafts at most, so twenty are
   * fetched and the newest is chosen here, which costs nothing and removes an
   * index from the list of things that have to be deployed for a command to
   * work at all. */
  const r = await fetch(
    `https://firestore.googleapis.com/v1/${DOC}/sites/${siteId}:runQuery`,
    {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${idToken}` },
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: "deployments" }],
          where: {
            fieldFilter: {
              field: { fieldPath: "draft" },
              op: "EQUAL",
              value: { booleanValue: true }
            }
          },
          limit: 20
        }
      })
    }
  );
  const rows = await jsonOrThrow(r, "Could not look for a draft");

  const one = doc => {
    const f = doc.fields || {};
    const str = k => f[k]?.stringValue || "";
    const num = k => Number(f[k]?.integerValue ?? f[k]?.doubleValue ?? 0);
    return {
      id: doc.name.split("/").pop(),
      title: str("title"),
      note: str("note"),
      files: num("files"),
      bytes: num("bytes"),
      createdAt: num("createdAt"),
      expiresAt: f.expiresAt?.integerValue ? num("expiresAt") : 0,
      previewKey: str("previewKey"),
      previewUntil: num("previewUntil")
    };
  };

  const all = (rows || [])
    .map(x => x.document)
    .filter(Boolean)
    .map(one)
    /* A test build is not a draft. It carries an expiry and throws itself away;
       a draft is a thing somebody is keeping. */
    .filter(d => !d.expiresAt)
    .sort((a, b) => b.createdAt - a.createdAt);

  return all[0] || null;
}

/* Point the project at a deploy it already holds, and stop calling that deploy
   a draft. Both in one commit, because a project pointed at a build still
   marked "never published" is a record that argues with itself. */
export async function publishDraft(idToken, siteId, deployId) {
  const r = await fetch(
    `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents:commit`,
    {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${idToken}` },
      body: JSON.stringify({
        writes: [
          {
            update: {
              name: `${DOC}/sites/${siteId}/deployments/${deployId}`,
              fields: fields({ draft: false })
            },
            updateMask: { fieldPaths: ["draft"] }
          },
          {
            update: {
              name: `${DOC}/sites/${siteId}`,
              fields: fields({ liveDeployId: deployId, status: "live", updatedAt: Date.now() })
            },
            updateMask: { fieldPaths: ["liveDeployId", "status", "updatedAt"] }
          }
        ]
      })
    }
  );
  await jsonOrThrow(r, "Could not publish that draft");
}

/* A temporary address for a build that has none. The same two fields the
   dashboard writes, and the same half hour: see previewUrl in
   src/lib/creators.ts for why a preview is its own host. */
export const PREVIEW_FOR = 30 * 60 * 1000;

export async function setPreview(idToken, siteId, deployId, key, until) {
  const r = await fetch(
    `https://firestore.googleapis.com/v1/${DOC}/sites/${siteId}/deployments/${deployId}`
      + `?updateMask.fieldPaths=previewKey&updateMask.fieldPaths=previewUntil`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: `Bearer ${idToken}` },
      body: JSON.stringify({ fields: fields({ previewKey: key, previewUntil: until }) })
    }
  );
  await jsonOrThrow(r, "Could not make that preview");
}

export async function revoke(key, idToken) {
  const hash = createHash("sha256").update(key).digest("hex");
  const r = await fetch(
    `https://firestore.googleapis.com/v1/projects/${PROJECT}`
    + `/databases/(default)/documents/deployKeys/${hash}`,
    { method: "DELETE", headers: { authorization: `Bearer ${idToken}` } }
  );
  return r.ok;
}

/* ---------- naming ---------- */

/* The first sixteen bytes of the file's SHA-256, which is what names a blob.
   Has to match the web app exactly or the two would never share a byte. */
export const hashOf = buf =>
  createHash("sha256").update(buf).digest("hex").slice(0, 32);

/* A web path as one database key. The database forbids `.`, `#`, `$`, `[`, `]`
   and `/`, and a web path is made almost entirely of the first and the last;
   base64url survives all of them and is reversible. */
export const keyOf = path => Buffer.from(path, "utf8").toString("base64url");

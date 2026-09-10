# aloic

Publish a folder to [Aloic](https://aloic.ai) from a terminal or a build machine.

```bash
curl -fsSL https://get.aloic.ai | sh
aloic login
aloic deploy ./dist
```

That is the whole thing. The installer puts the CLI under `~/.aloic` and the
`aloic` command in `~/.local/bin`, checks every file against a published hash,
never asks for root, and offers to sign you in on the spot. `aloic deploy`
walks the folder, sends only the files that changed, and points your project at
the result.

A shell cannot change its parent's PATH, so `aloic` is short in the **next**
terminal you open. In the one you installed from, either use the path the
installer prints or run `source ~/.aloic/env`. Remove all of it with
`aloic uninstall`.

Requires Node 18 or newer, which the installer checks for before it downloads
anything. To pin a version, pass it: `curl -fsSL https://get.aloic.ai | sh -s -- 0.1.0`.

## Commands

| | |
|---|---|
| `aloic login` | Sign this machine in through your browser |
| `aloic logout` | Forget the key on this machine |
| `aloic init` | Choose which project this folder publishes to |
| `aloic deploy [folder]` | Publish a folder and point the project at it |
| `aloic projects` | List the projects this machine can publish to |
| `aloic whoami` | Show who this machine is signed in as |

Running `aloic deploy` with nothing set up does the sign in and the project
choice on the way past. The other commands exist for when you want to do those
deliberately.

### Options

| | |
|---|---|
| `--title <text>` | Names the deploy, shown as its heading |
| `--description <text>` | What changed, shown under the name |
| `--project <slug>` | Publish to this project, ignoring `.aloic` |
| `--draft` | Upload without pointing the project at it |
| `--quiet` | Print only the address at the end |

## In a build

Set `ALOIC_KEY` and skip the sign in entirely:

```bash
ALOIC_KEY=alo_... npx aloic deploy ./dist
```

There is a ready made GitHub Actions workflow in `github-action.yml`. Copy it
to `.github/workflows/deploy.yml` and add the key as a repository secret. The
build runs on GitHub's machine and only the finished folder is sent.

## What it writes

| | |
|---|---|
| `~/.aloic/config.json` | The terminal key, mode `0600`. Yours, per machine |
| `./.aloic` | Which project this folder publishes to. Commit it |

The key is per machine so signing in once covers every project on this
computer. Which project a folder publishes to is a fact about the folder, so it
lives beside it and can be committed, which is what lets a whole team deploy
the same repository without each of them choosing from a list.

## What a terminal key can do

Publish to the projects on your account, and nothing else. It cannot change
your account, your domains or your billing, and it cannot make more keys.
Revoke one at any time in Settings on aloic.ai.

## Notes

- Only files that changed are uploaded. Content is addressed by its hash, so a
  second deploy of a site whose images did not change sends the one edited file.
- `node_modules`, `.git`, `.env` and similar are skipped rather than refused,
  so pointing this at a project root works.
- No dependencies. This is the one tool in a pipeline that has to still work on
  a machine nobody has looked at in a year.
- Requires Node 18 or newer.

# Aloic CLI

Publish a folder to [Aloic](https://aloic.ai) from your terminal or a CI build.

## Get Started

```bash
curl -fsSL https://get.aloic.ai | sh
aloic
```

Running `aloic` for the first time signs you in and sets up the CLI. After setup, running `aloic deploy` publishes your folder to Aloic and gives you the deployment URL. Requires Node 18 or newer.

Already using npm? Install it globally instead:

```bash
npm install -g aloic
```

## Features

- **Fast redeploys.** The CLI instantly sends your build to Aloic to be published. Only new or changed files are uploaded, prioritizing speed.
- **Previews.** Upload a build without making it live, open it at its own address, and publish it when you're ready.
- **Works from a project root.** `node_modules`, `.git`, `.env`, and similar files are skipped automatically, so you can deploy without cleaning up first.
- **Built for teams.** Connect to GitHub and everyone on your team deploys the same repository to the same project.
- **Built for CI.** Deploys run automatically, and errors exit readably.
- **No dependencies.** The CLI needs nothing beyond Node.

## Deploying

```bash
aloic deploy ./dist --title "Added something to something"
```

Running the command deploys your folder to Aloic. Passing `--title` becomes your deployment title in the Aloic dashboard.
Your project is automatically linked to a folder and is saved in `./.aloic`.

Your site is published from the folder that holds `index.html`, so server code and config files next to it stay private. Pass `--root <folder>` to choose a different folder, or `--root .` to publish everything.

## Previews

```bash
aloic deploy ./dist --preview
```

Running the command uploads your build without replacing your live deployment. Your current deployment stays published, and the CLI prints your preview's address.

Every deployment gets its own permanent address, `<secret>--<project>.aloic.ai`, so you can open a preview or send it to someone right away. The secret is a random word, so nobody can guess the address from your project's name. Previews aren't indexed by search engines or counted in your analytics.

```bash
aloic deploy preview
```

Publishes your newest preview, making it your live deployment. You can also publish it from its page in the Aloic dashboard.

## Projects with a backend

```bash
aloic deploy            # your files, and your backend if you have one
aloic deploy --backend  # only your backend
aloic deploy --files    # only your files
```

Your server runs on your own Vercel account and answers at the same address as your site. Connect one in your project's settings under Backend, or say yes when `aloic deploy` finds a server in your folder. After that, one `aloic deploy` ships your site and your server together.

Vercel installs and builds your backend, so the CLI sends its source: up to 400 files and 2.5 MB. The command finishes as soon as your backend's build is queued, and Aloic routes to it the moment the build is ready.

## Environment variables

```bash
aloic env add API_TOKEN
```

Running the command asks for the value and hides it as you type. Values are saved as secrets unless you pass `--config`, and apply to every environment unless you pass `--production`, `--preview`, or `--development`. In CI, pipe the value in: `echo -n "$TOKEN" | aloic env add API_TOKEN`.

If your project has a backend, adding or removing a variable changes it there too.

Run `aloic env` to list your project's variables, and `aloic env rm API_TOKEN` to remove one. Secrets can't be read back by anyone, including the CLI and the dashboard, so there's no command to download them.

## Commands

| Command | Description |
|---|---|
| `aloic` | Set up the CLI on this machine. Once set up, lists every command. |
| `aloic deploy [folder]` | Publish a folder, and your backend if you have one. |
| `aloic deploy preview` | Publish your newest preview. |
| `aloic test preview` | Open your newest preview at a temporary address. |
| `aloic env` | List your project's environment variables. |
| `aloic env add <NAME>` | Set an environment variable, or replace it. |
| `aloic env rm <NAME>` | Remove an environment variable. |
| `aloic init` | Choose which project this folder publishes to. |
| `aloic projects` | List the projects you can publish to. |
| `aloic login` | Sign this machine in through your browser. |
| `aloic logout` | Sign out and revoke this machine's key. |
| `aloic whoami` | Show the account this machine is signed in as. |
| `aloic settings` | Change your default settings for the CLI. |
| `aloic update` | Update to the newest version. |
| `aloic uninstall` | Remove the CLI and its saved key from this machine. |

If you haven't signed in or chosen a project yet, `aloic deploy` asks you to do both before publishing.

### Deploy options

| Option | Description |
|---|---|
| `--title <text>` | Your deployment's title in the Aloic dashboard. Required in CI. |
| `--description <text>` | What changed, shown under the title. |
| `--project <slug>` | Publish to this project instead of the one saved in `.aloic`. |
| `--root <folder>` | Publish this folder instead of the one with your `index.html`. |
| `--preview` | Upload without making it live. Your current deployment stays published. |
| `--publish` | Make this deployment live, whatever your settings say. |
| `--files` | Deploy only your files, leaving your backend as it is. |
| `--backend` | Deploy only your backend, leaving your files as they are. |
| `--quiet` | Print only the deployment URL. |

### Other options

| Option | Description |
|---|---|
| `--version` | Print the installed version. |
| `aloic login --force` | Sign in again, replacing this machine's key. |
| `aloic uninstall --keep-key` | Uninstall without removing your saved key. |
| `aloic uninstall --yes` | Uninstall without asking for confirmation. |

## Settings

```bash
aloic settings
```

You choose these during setup and can change them at any time.

| Setting | Options |
|---|---|
| When you run `aloic deploy` | **Publish it** (default), or create a preview. |
| Before publishing | **Publish immediately** (default), or ask me first. |
| New versions of the CLI | **Update automatically** (default), or notify me. |

Choosing **Ask me first** means the CLI confirms that you want to publish each deployment to production. Confirmations and automatic updates only happen in an interactive terminal, so CI builds never pause and never update themselves.

## Deploying from CI

```bash
ALOIC_KEY=alo_... npx aloic deploy ./dist --title "Release 1.4"
```

Setting `ALOIC_KEY` deploys without signing in. Create a key in Settings on aloic.ai.

For GitHub Actions, copy `github-action.yml` from this repository to `.github/workflows/deploy.yml` and add your key as a repository secret named `ALOIC_KEY`. Every push to `main` builds your site on GitHub and deploys the finished folder, with the commit message as the title.

## Working with a team

Your key is saved per machine in `~/.aloic/config.json`, so signing in once covers every project you publish from that computer. Don't share it or commit it.

The project a folder publishes to is saved in `./.aloic`. Commit that file, and everyone on your team deploys to the same project without choosing one.

## Terminal key permissions

A terminal key can publish to the projects on your account and nothing else. It can't change your account settings, domains, or billing, and it can't create other keys. You can revoke a key at any time in Settings on aloic.ai.

## Good to know

- **Skipped files.** Dependency, version control, cache, and editor folders (such as `node_modules`, `.git`, `.next`, and `.vscode`), `.env` files, and system files like `.DS_Store` are never uploaded.
- **Limits.** Each deployment can include up to 400 files and 25 MB in total. Files over 4 MB are skipped.
- **Analytics.** Aloic adds a small analytics script to the HTML pages it serves.
- **Pinning a version.** Pass a version to the installer: `curl -fsSL https://get.aloic.ai | sh -s -- 0.1.0`.


Elevate ideas
Aloic

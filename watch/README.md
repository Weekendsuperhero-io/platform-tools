# muse-watch

Cloudflare Worker that waits on a Jules session without holding a GitHub Actions runner. Used by the PR-description workflow when `watch-url` + `MUSE_WATCH_HMAC` are set.

The queue holds `{session_id, repo, pr, deadline, start_run_id}` plus optional `agent` / `base_branch`. Prompt text, diffs, and Jules answers never leave Actions.

This Worker is **not** wired to the Cloudflare GitHub App (that app is for another repo). Deploy from this directory with Wrangler.

All `wrangler` commands below assume:

```bash
cd watch
```

## Secrets (1Password or pasted values)

```bash
cp .env.example .env
# edit .env — each secret can be the value or op://Vault/Item/field
pnpm secrets:sync
```

That writes the Worker secrets (`wrangler secret put`) and the org GitHub
variable/secrets (`MUSE_WATCH_URL`, `MUSE_WATCH_HMAC`, `JULES_API_KEY`,
optional `LINEAR_API_KEY`). Values are never printed. `.env` is gitignored.

## One-time setup (CLI first)

Do these in order. Browser is only needed for `wrangler login` (once) and creating the GitHub PAT.

### 1. Land the code

Commit this branch and merge to `main`. Apply jobs resolve composite actions from `main`.

### 2. Log Wrangler into the same Cloudflare account as your other Worker

```bash
wrangler login
wrangler whoami
```

### 3. Create KV + queue, then put the KV id in `wrangler.toml`

```bash
wrangler kv namespace create TICKETS
wrangler queues create muse-watch
```

The KV command prints an `id`. Replace `REPLACE_ME` in `wrangler.toml` with that id. Commit that one-line change (or the next deploy will not find the namespace).

### 4. GitHub PAT (the one step that is still a website)

https://github.com/settings/personal-access-tokens/new

| Field | Value |
| --- | --- |
| Resource owner | `Weekendsuperhero-io` |
| Repository access | **All repositories** (current and future) |
| Repository permissions | **Contents: Read and write** (required for `POST /repos/.../dispatches`). Actions: write is *not* enough. |
| Expiration | 90 days |

If the org requires approval for fine-grained tokens, approve it as an org owner.

### 5. Worker secrets (stay on Cloudflare, not in GitHub Actions)

```bash
# same string you will set as the org GitHub secret
openssl rand -hex 32 | wrangler secret put MUSE_WATCH_HMAC
# you also need that hex saved — generate first, then put:

HMAC=$(openssl rand -hex 32)
echo "$HMAC"          # copy this; you need it again in step 6
printf '%s' "$HMAC" | wrangler secret put MUSE_WATCH_HMAC

printf '%s' "$JULES_API_KEY" | wrangler secret put JULES_API_KEY
printf '%s' "$GITHUB_DISPATCH_TOKEN" | wrangler secret put GITHUB_DISPATCH_TOKEN
```

`JULES_API_KEY` is the same key Actions already uses. `GITHUB_DISPATCH_TOKEN` is the PAT from step 4.

### 6. Deploy

```bash
wrangler deploy
```

Copy the printed `https://muse-watch.<subdomain>.workers.dev` URL (no trailing slash).

### 7. Org GitHub var + secret (`gh`, not the website)

```bash
# default visibility is private-repos only — public consumers see an empty var
gh variable set MUSE_WATCH_URL --org Weekendsuperhero-io --visibility all \
  --body "https://muse-watch.gk8b9qcr52.workers.dev"
gh secret set MUSE_WATCH_HMAC --org Weekendsuperhero-io --visibility all
# paste the same HMAC as step 5 when prompted
```

`JULES_API_KEY` should already be an org secret. If it is only on some repos, set it at the org too:

```bash
gh secret set JULES_API_KEY --org Weekendsuperhero-io --visibility all
```

### 8. Dogfood on this repo

Open a PR on `platform-tools` whose body contains `@agent pr-title`.

- Start job should finish in ~30s (create + register, no long poll).
- A second run `Apply Jules PR description` should appear a minute or two later and write the title/body.

If start still polls for minutes, `MUSE_WATCH_URL` or `MUSE_WATCH_HMAC` is not visible to this repo (`gh variable list --org Weekendsuperhero-io` / `gh secret list --org Weekendsuperhero-io`).

### 9. Other consumers (later)

Each repo still needs the wrapper in `docs/muse-workflows.md` (`repository_dispatch` + `mode` inputs). After that, org inherit is enough. No new PAT.

## Local

```bash
# watch/.dev.vars
# MUSE_WATCH_HMAC=dev-hmac
# JULES_API_KEY=...
# GITHUB_DISPATCH_TOKEN=...
wrangler dev
```

## Token shape

One org-owned fine-grained PAT, all repositories, Actions: read/write only. Not a token per consumer. Repos outside `Weekendsuperhero-io` stay on the blocking `jules-ai` poll.

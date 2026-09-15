# Cloudflare deployment

Repo Atlas deploys the Vite `dist` directory to Cloudflare Workers Static Assets.
The Worker is named `repo-atlas`. It has no application code, runtime bindings,
or runtime secrets. Cloudflare publishes the committed `public/atlas.json` and
`public/atlas-list.html`; the Python pipeline runs locally before those files are
committed.

Run all commands from the repository root (the directory containing
`package.json` and `wrangler.jsonc`). Node.js 24+ and pnpm 12.4.1 are required.

## Local checks and deployment

```bash
pnpm install --frozen-lockfile
pnpm run deploy:check
pnpm run preview:cloudflare
```

`deploy:check` builds the site and runs `wrangler deploy --dry-run`; it does not
publish. `preview:cloudflare` builds and serves the production assets locally at
`http://localhost:8787`. Neither command requires Cloudflare login. For normal
frontend development with hot reload, continue to use `pnpm dev`.

Check the map, search, filters, repository details, and a copied query-string
link. `/atlas.json` must return JSON and `/atlas-list.html` must open the full
repository list. Cloudflare's default HTML handling redirects the latter to
`/atlas-list`. Missing assets and unknown paths return 404; there is no SPA
fallback because shareable application state lives in query parameters at `/`.

When ready to publish to the configured account and domain:

```bash
pnpm exec wrangler login
pnpm exec wrangler whoami
pnpm run deploy
```

The configuration selects the account that manages `haroldmartin.me`. `deploy` builds
before uploading, so it cannot accidentally reuse an old `dist` directory after
a failed build. It publishes to both `haroldmartin.me` and the `workers.dev`
address. To stage a new Worker before a domain cutover, omit `routes` in a local
configuration copy and verify its Workers address before adding the domain.

For unattended CLI deployment, use `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` in the deployment environment. Use a token scoped to the
intended account with Workers Scripts Edit permission. Keep credentials out of
the repository and out of any `VITE_` variable.

## Public site metadata

Canonical, Open Graph, and Twitter image URLs default to
`https://haroldmartin.me`. To build for another origin:

```bash
VITE_SITE_URL=https://atlas.example.com pnpm run build
```

The same variable can be set in an ignored `.env.local` file or Cloudflare's
build variables. It must be an HTTP(S) origin without credentials, a subpath,
query, or fragment; a trailing slash is normalized away. This changes metadata
at build time, not DNS or routing. Preview builds use the production canonical
URL unless explicitly overridden.

## Automatic deployments from GitHub

Commit and push the deployment configuration and reviewed atlas outputs first.
In Cloudflare **Workers & Pages**, create a Worker from the existing GitHub
repository `hbmartin/repo-atlas`, or connect that repository under **Settings >
Builds** if `repo-atlas` was already created with the CLI. Reuse the same Worker.

Use these settings:

| Setting | Value |
| --- | --- |
| Worker name | `repo-atlas` |
| Production branch | `main` |
| Root directory | Repository root (`/` in the dashboard), not a nested `repo-atlas` directory |
| Build command | `pnpm install --frozen-lockfile && pnpm run build` |
| Deploy command | `pnpm exec wrangler deploy` |
| Non-production deploy command, if branch builds are enabled | `pnpm exec wrangler versions upload` |
| `NODE_VERSION` build variable | `24` |
| `PNPM_VERSION` build variable | `12.4.1` |
| `SKIP_DEPENDENCY_INSTALL` build variable | `1` |
| `VITE_SITE_URL` build variable | `https://haroldmartin.me` |

Cloudflare manages Git authentication and can generate its deployment token.
Do not add Python setup, GitHub pipeline tokens, or `OPENAI_API_KEY` to the
Cloudflare build. The committed static snapshot is sufficient. The existing
GitHub Actions CI continues to run independently; Cloudflare Builds does not
wait for those checks. Use branch protection on `main` if CI must gate releases.

See Cloudflare's [build configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)
and [tool version overrides](https://developers.cloudflare.com/workers/ci-cd/builds/build-image/).

## Launch on haroldmartin.me

The production configuration includes the `haroldmartin.me` Custom Domain and
keeps `workers_dev: true` for deployment checks and recovery. The first release
was verified at its Workers address before adding the domain. The following
procedure documents the cutover and can be used when restoring or moving it.

1. Confirm that `haroldmartin.me` is an active zone in the same Cloudflare
   account. Export its DNS records and record the current apex/www website
   records, Worker routes, Redirect Rules, Page Rules, and any origin-host
   redirects. Keep this record outside the public repository for rollback.
2. Check the existing redirect from `haroldmartin.me` to `www.haroldmartin.me`.
   Disable any matching Cloudflare redirect when switching the apex to the
   Worker, so it cannot loop with the new reverse redirect. If the redirect
   comes from the old origin, switching the apex origin will replace it.
3. Keep the following top-level `routes` entry in `wrangler.jsonc` and deploy.
   Replace only website DNS records that conflict with adding the
   Custom Domain. Leave mail, verification, and unrelated records intact.

   ```json
   "routes": [
     { "pattern": "haroldmartin.me", "custom_domain": true }
   ]
   ```

   Cloudflare provisions the Custom Domain's DNS record and certificate. Keep
   this route in the configuration for future deployments. If using the
   dashboard to attach the domain initially, also commit the matching route.

4. In the zone's **Rules > Redirect Rules**, add a Single Redirect matching
   `http.host eq "www.haroldmartin.me"`. Choose a dynamic target expression
   `concat("https://haroldmartin.me", http.request.uri.path)`, status **301**,
   and enable **Preserve query string**. The hostname condition matches both
   HTTP and HTTPS. Ensure `www` has a proxied DNS record; for a redirect-only
   hostname, use a proxied A record with the placeholder address `192.0.2.1`
   when replacing its previous website record. Confirm edge certificate
   coverage for `www` before considering launch complete.
5. Verify HTTPS at both hostnames, the map and list, `/atlas.json`, `/og.png`,
   and missing-asset 404s. Confirm that
   `https://www.haroldmartin.me/?lang=Python&layout=alt` redirects to the same
   path and query on `https://haroldmartin.me`, and
   `https://www.haroldmartin.me/atlas-list.html?check=1` preserves its path and
   query before Cloudflare applies its normal HTML canonicalization.

Cloudflare documents [Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
and [www-to-apex redirects](https://developers.cloudflare.com/rules/url-forwarding/examples/redirect-www-to-root/).

For an application rollback, revert the affected commit and redeploy the known
good code and atlas snapshot. For a domain rollback, remove the Custom Domain
route from configuration and deployment, disable the new www redirect, then
restore the recorded website DNS records and previous redirect settings. Check
both hostnames again; browsers may retain cached permanent redirects.

## Publish an updated atlas

Run `uv run atlas run` locally, inspect `uv run atlas report` and the generated
labels, then review and commit both `public/atlas.json` and
`public/atlas-list.html`. Run the frontend checks and `pnpm run deploy:check`.
The build validates snapshot consistency without requiring a fixed repository count.
Push the snapshot to `main` to trigger Cloudflare, or use `pnpm run deploy` for
a manual release. Do not commit the local cache, credentials, or reports.

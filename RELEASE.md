# Release

## First publish (0.1.0), by hand

The npm package does not exist yet, so the trusted publisher cannot be set up before it. Publish 0.1.0 once from a checkout:

1. `git checkout main && git pull`, then `npm ci`.
2. `npm run lint && npm run build && npm test`.
3. `npm login` (account `socialground`).
4. `RELEASE_MODE=1 npm publish --access public --otp=<code>` from the package directory. `RELEASE_MODE=1` is needed because the `prepublishOnly` guard blocks a plain `npm publish`.
5. Do not push a `v0.1.0` tag: the publish workflow would fail on the already published version.

## Add the trusted publisher (once, after 0.1.0 exists)

1. Open https://www.npmjs.com/package/n8n-nodes-hellohop/access (package **Settings**).
2. Under **Trusted Publisher** choose **GitHub Actions**.
3. Organization or user: `socialgroundco`. Repository: `n8n-nodes-hellohop`. Workflow filename: `publish.yml`. Environment: `npm-publish`.
4. Save. No npm token is stored anywhere.

## Every later release (0.1.1 and on)

1. Bump `version` in `package.json` and add a CHANGELOG entry. Commit and push to `main`.
2. `git tag v0.1.1 && git push origin v0.1.1`.
3. The `Publish to npm` workflow lints, builds, tests, checks tag == `package.json` version, packs, then publishes the tarball with provenance from the `npm-publish` environment.

## Verified community node submission

After a provenance-published version is live, submit the package in the n8n Creator Portal. Reviews can take up to four weeks. Run `npx @n8n/scan-community-package n8n-nodes-hellohop` first and fix anything it reports.

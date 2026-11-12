# Releasing

1. Update version and changelog together; regenerate the lockfile with `npm install --package-lock-only --ignore-scripts`.
2. Run `npm ci --ignore-scripts`, `npm run check`, `npm test`, `npm run verify:load`, and `npm pack --dry-run`.
3. Review the tarball file list for credentials, private transcripts, node_modules, test workspaces, and accidental runtime dependencies.
4. Push the tested commit and wait for CI on Node 22/24 and Windows. Create a tag or GitHub release only with separate explicit authorization.
5. Build with `npm pack --ignore-scripts`, then verify the tarball in an isolated config: `node scripts/verify-install.mjs ./pi-continuity-0.5.0.tgz`. The verifier extracts local `.tgz` files before installing them.
6. Verify GitHub installation in an isolated config: `node scripts/verify-install.mjs git:github.com/zhexusun10/pi-continuity`.
7. Publishing is a separate, explicitly authorized step. For a manual release, publish the exact verified artifact with `npm publish ./pi-continuity-0.5.0.tgz --access public`; authentication/OTP may be required. Building or pushing Git commits does not publish npm.
8. After publication, verify the actual npm source using the same installer (`npm:pi-continuity`) and confirm the registry version/dist-tag. Do not claim an unpublished version is already available from the registry.

Pi supplies host modules; never bundle its runtime or turn host peer dependencies into regular dependencies. The `pi-package` keyword enables package discovery, but does not promise gallery indexing. Real-model benchmarks are opt-in and consume provider usage. Never upload secrets, personal prompts, or raw sensitive reasoning as release assets.

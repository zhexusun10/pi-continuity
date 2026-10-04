# Releasing

1. Update version and changelog together; regenerate the lockfile with `npm install --package-lock-only --ignore-scripts`.
2. Run `npm ci --ignore-scripts`, `npm run check`, `npm test`, `npm run verify:load`, and `npm pack --dry-run`.
3. Review the tarball file list for credentials, private transcripts, node_modules, test workspaces, and accidental runtime dependencies.
4. Push the tested commit and wait for CI on Node 22/24 and Windows. Tag the version and create a GitHub release with compatibility and recovery-limit notes.
5. Verify the built tarball in an isolated config: `node scripts/verify-install.mjs ./pi-continuity-0.1.0.tgz`. The verifier extracts local `.tgz` files before installing them.
6. Verify GitHub installation in an isolated config: `node scripts/verify-install.mjs git:github.com/zhexusun10/pi-continuity`.
7. If publishing to npm, explicitly obtain release authorization, then use `npm publish --access public`. Authentication/OTP may be required.
8. Verify the actual published npm source using the same installer (`npm:pi-continuity`), and update the package version/changelog and installation documentation together.

Pi supplies host modules; never bundle its runtime or turn host peer dependencies into regular dependencies. The `pi-package` keyword enables package discovery, but does not promise gallery indexing. Real-model benchmarks are opt-in and consume provider usage. Never upload secrets, personal prompts, or raw sensitive reasoning as release assets.

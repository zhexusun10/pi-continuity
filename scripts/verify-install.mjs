import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";

// Uses an isolated config, never submits a model prompt, and works before npm publication.
const requestedSource = process.argv[2] ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = mkdtempSync(join(tmpdir(), "pi-continuity-install-"));
const packageRoot = resolve(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "..");
const cli = join(packageRoot, "dist/bundle/cli.js");
let source = requestedSource;
if (requestedSource.toLowerCase().endsWith(".tgz")) {
  const tarball = resolve(requestedSource);
  const extracted = spawnSync(process.platform === "win32" ? "tar.exe" : "tar", ["-xzf", basename(tarball), "-C", root], {
    cwd: dirname(tarball), encoding: "utf8",
  });
  if (extracted.status !== 0) throw Error(extracted.stderr || extracted.stdout || String(extracted.error));
  source = join(root, "package");
}
const sourceCandidates = [source, ...(isAbsolute(source) ? [relative(root, source)] : [])];
const env = {
  ...process.env, PI_CODING_AGENT_DIR: join(root, "agent"), PI_PACKAGE_DIR: packageRoot,
  PI_OFFLINE: "1", npm_config_ignore_scripts: "true",
};
let child;
try {
  for (const args of [["install", source], ["list"]]) {
    const result = spawnSync(process.execPath, [cli, ...args], { env, cwd: root, encoding: "utf8", timeout: 90_000 });
    if (result.status !== 0) throw Error(result.stderr || result.stdout || String(result.error));
    if (args[0] === "list" && !sourceCandidates.some((candidate) => result.stdout.includes(candidate))) throw Error("Installed source is absent from pi list.");
  }
  child = spawn(process.execPath, [cli, "--mode", "rpc", "--no-session", "--offline", "--no-approve", "--continuity=false", "--continuity-tool-tail=false"], { env, cwd: root });
  let buffer = "", errors = "";
  child.stderr.on("data", (data) => { errors += data; });
  const loaded = await new Promise((resolveResult, reject) => {
    const timer = setTimeout(() => reject(Error("RPC load timed out: " + errors)), 30_000);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", () => { clearTimeout(timer); reject(Error("RPC closed before command response: " + errors)); });
    child.stdout.on("data", (data) => {
      buffer += data;
      while (buffer.includes("\n")) {
        const i = buffer.indexOf("\n"), line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        let result;
        try { result = JSON.parse(line); } catch { continue; }
        if (result.type === "response" && result.command === "get_commands") {
          clearTimeout(timer);
          resolveResult(result.success && result.data?.commands?.some((command) => command.name === "pi-continuity"));
        }
      }
    });
    child.stdin.write(JSON.stringify({ type: "get_commands", id: "verify-continuity" }) + "\n");
  });
  if (!loaded) throw Error("Package installed, but Pi did not load /pi-continuity.");
  console.log(`PASS: ${requestedSource} installs, appears in pi list, and loads /pi-continuity in offline RPC mode.`);
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    const closed = once(child, "close");
    child.kill();
    await closed;
  }
  rmSync(root, { recursive: true, force: true });
}

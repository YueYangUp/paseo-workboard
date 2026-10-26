import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (
  process.argv.length > 3 ||
  (process.argv[2] && process.argv[2] !== "--ui")
) {
  throw new Error("Usage: node scripts/run-host-checks.mjs [--ui]");
}

const repository = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const artifacts = process.env.WORKBOARD_HOST_ARTIFACTS
  ? path.resolve(process.env.WORKBOARD_HOST_ARTIFACTS)
  : mkdtempSync(path.join(tmpdir(), "workboard-host-artifacts-"));
mkdirSync(artifacts, { recursive: true });
const home = mkdtempSync(path.join(tmpdir(), "paseo-workboard-host-"));
const packageDirectory = path.join(home, "packed");
const extracted = path.join(home, "extracted");
mkdirSync(packageDirectory);
mkdirSync(extracted);
const log = path.join(artifacts, "runner.log");
writeFileSync(log, "");
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !/^PASEO_/i.test(key)),
);
Object.assign(env, {
  PASEO_HOME: home,
  WORKBOARD_INTEGRATION_HOME: home,
  WORKBOARD_HOST_ARTIFACTS: artifacts,
});

function run(command, args, timeout = 60_000) {
  const label = `${command} ${args.join(" ")}`;
  appendFileSync(log, `\n$ ${label}\n`);
  const result = spawnSync(command, args, {
    cwd: repository,
    env,
    encoding: "utf8",
    timeout,
    maxBuffer: 16 * 1024 * 1024,
  });
  for (const [stream, output] of [
    [process.stdout, result.stdout],
    [process.stderr, result.stderr],
  ]) {
    if (output) {
      stream.write(output);
      appendFileSync(log, output);
    }
  }
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  if (result.status !== 0)
    throw new Error(`${label}: exited ${result.status ?? result.signal}`);
  return result.stdout;
}

async function freeLoopbackPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

let startAttempted = false;
let failure;
let stopped = true;
try {
  const port = await freeLoopbackPort();
  const listen = `127.0.0.1:${port}`;
  env.WORKBOARD_BASE_URL = `http://${listen}`;
  writeFileSync(
    path.join(home, ".paseo-workboard-integration"),
    "paseo-workboard-integration-v1\n",
  );
  writeFileSync(
    path.join(home, "config.json"),
    JSON.stringify({
      daemon: { listen, relay: { enabled: false } },
      pluginsEnabled: true,
      features: { webUi: { enabled: true } },
    }),
  );
  console.log(`Isolated Paseo home: ${home}`);
  console.log(`Host check artifacts: ${artifacts}`);

  const [packed] = JSON.parse(
    run(
      "npm",
      [
        "pack",
        "--ignore-scripts",
        "--json",
        "--pack-destination",
        packageDirectory,
      ],
      120_000,
    ),
  );
  assert.equal(packed.name, "paseo-workboard");
  const archive = path.join(packageDirectory, packed.filename);
  assert(existsSync(archive), `npm pack did not create ${archive}`);
  run("tar", ["-xzf", archive, "-C", extracted]);
  const plugin = path.join(extracted, "package");
  assert(existsSync(path.join(plugin, "paseo-plugin.json")));

  startAttempted = true;
  run("paseo", ["daemon", "start", "--home", home, "--timeout", "30"], 45_000);
  const status = JSON.parse(run("paseo", ["status", "--home", home, "--json"]));
  assert.equal(realpathSync(status.home), realpathSync(home));
  assert.equal(status.listen, listen);
  assert(status.daemonVersion, "Paseo did not report its version");
  run("paseo", ["plugin", "install", "--home", home, plugin], 120_000);
  run("npm", ["run", "test:integration"], 300_000);
  // Idle Agents must stay unloaded: seed some, restart the daemon so none is loaded, then
  // let Workboard start and refresh and check that it resumed none of them.
  run("node", ["scripts/check-idle-wake.mjs", "seed"], 120_000);
  run("paseo", ["daemon", "stop", "--home", home], 45_000);
  run("paseo", ["daemon", "start", "--home", home, "--timeout", "30"], 45_000);
  run("node", ["scripts/check-idle-wake.mjs", "verify"], 240_000);
  // Agents the tests create are always recent, so a second daemon judges time 40 days ahead
  // (honored only in this marked home): the end-to-end archive tests and the UI archive
  // confirmation need a due idle workspace.
  run("paseo", ["daemon", "stop", "--home", home], 45_000);
  env.WORKBOARD_TEST_CLOCK_OFFSET_MS = String(40 * 24 * 60 * 60 * 1000);
  env.WORKBOARD_TEST_CLOCK_FILE = "1";
  run("paseo", ["daemon", "start", "--home", home, "--timeout", "30"], 45_000);
  run("npm", ["run", "test:integration"], 300_000);
  if (process.argv[2] === "--ui") run("npm", ["run", "test:ui"], 300_000);
} catch (error) {
  failure = error;
  appendFileSync(log, `${String(error)}\n`);
  console.error(error);
} finally {
  if (startAttempted) {
    try {
      run("paseo", ["daemon", "stop", "--home", home], 45_000);
    } catch (error) {
      stopped = false;
      failure ??= error;
      console.error(`Daemon stop failed; preserved ${home}:`, error);
    }
  }
  if (failure) {
    const config = path.join(home, "config.json");
    if (existsSync(config))
      copyFileSync(config, path.join(artifacts, "daemon-config.json"));
    for (const name of ["daemon.log", "logs"]) {
      const source = path.join(home, name);
      if (existsSync(source))
        cpSync(source, path.join(artifacts, name), { recursive: true });
    }
  }
  writeFileSync(
    path.join(artifacts, "result.json"),
    JSON.stringify(
      {
        passed: !failure,
        stopped,
        home: stopped ? null : home,
        error: failure ? String(failure) : null,
      },
      null,
      2,
    ),
  );
  if (stopped) rmSync(home, { recursive: true, force: true });
}
if (failure) process.exitCode = 1;

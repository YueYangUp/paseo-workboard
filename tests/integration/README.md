# Isolated Paseo integration tests

中文：[中文](README.zh-CN.md)

The host and UI suites are separate from `npm test`. They require a Paseo CLI
whose version satisfies `paseo-plugin.json`, with `paseo` on `PATH`.

## Run the CI checks locally

After `npm ci`, run:

```sh
npm run test:host
```

The runner packs the current checkout, installs the unpacked tarball without
development dependencies into a fresh marked home, and runs the integration
suite. It chooses a loopback port, disables relay access, stops the daemon, and
removes the home after the run. A failed stop preserves the home for diagnosis.
It never uses an existing Paseo home or daemon.

After the integration suite, the runner also checks that Workboard does not
resume idle Agents (`scripts/check-idle-wake.mjs`): it seeds idle fixture
Agents, restarts the daemon so none is loaded, lets Workboard start and run a
periodic refresh, and fails if the daemon log shows an `Agent resumed from
persistence` for `clientId: plugin:paseo-workboard`. A control request from the
script itself must log such a resume, so a host that words the line differently
fails instead of passing silently. The fixture provider has no provider
children, so children of an idle parent are covered only by unit tests, and the
suite cannot archive an idle fixture end to end on the real clock because its
Agents are always recent.

For that reason the runner then restarts the daemon with
`WORKBOARD_TEST_CLOCK_OFFSET_MS` set to 40 days and runs the suite again (only
the end-to-end archive group runs in that mode) and, with `--ui`, the browser
tests. The offset moves only Workboard's own clock, so an idle fixture counts as
old, and it is honored only when the Paseo home is a temporary directory that
holds the `.paseo-workboard-integration` marker; otherwise the real clock is
used without any message. To run that group against your own marked test home,
start its daemon with the variable set and export the same variable for
`npm run test:integration`; never set it on a personal daemon.

The runner also sets `WORKBOARD_TEST_CLOCK_FILE=1` for the offset run. In this
mode, the same marked temporary home can hold `.workboard-clock-offset-ms`,
containing a nonnegative integer offset in milliseconds. The clock accepts only
forward changes; missing, invalid or decreasing values keep the last accepted
offset. Both the server clock and snapshot offset use the current value. This
lets the suite observe zero Agents, create and delete a real Agent, and prove
that automatic archive waits for the new empty period without restarting the
plugin or editing its stored evidence. Outside this explicit test mode no clock
file is read.

To also exercise the actual Paseo Web UI in headless Chromium:

```sh
npx playwright install --only-shell chromium
npm run test:host -- --ui
```

On Linux, `npx playwright install --with-deps --only-shell chromium` also installs the required
system libraries. CI runs this command against every Paseo version in the `host`
matrix of `.github/workflows/ci.yml`. The smoke
suite uses fictional tasks and the deterministic fixture provider; it covers
view switching and archive-setting interactions, and fails on uncaught page
errors. It does not cover all layouts, themes, accessibility, mobile clients,
or providers.

Logs and failure screenshots/traces go to a temporary artifact directory printed
by the runner. Set `WORKBOARD_HOST_ARTIFACTS` to choose that directory; CI uploads
it on failure. Standalone browser runs use ignored `test-results/` by default.

## Use an already-running test host

For targeted debugging, `npm run test:integration` runs `*.integration.ts` files
against an already-running isolated daemon prepared as follows.

The shell examples below use POSIX syntax. The harness uses the system temporary
directory and accepts `/tmp` when present; it does not require that alias.
Fixture Git commands use isolated configuration, without personal signing,
hooks, or ignore rules.

## Prepare a temporary home

Create a disposable home beneath the system temporary directory, then write a
loopback-only daemon configuration. Change `6768` to an unused local port if
it is already occupied.

```sh
WORKBOARD_INTEGRATION_HOME="$(mktemp -d "${TMPDIR:-/tmp}/paseo-workboard.XXXXXX")"
export WORKBOARD_INTEGRATION_HOME
printf '%s\n' paseo-workboard-integration-v1 > "$WORKBOARD_INTEGRATION_HOME/.paseo-workboard-integration"
printf '%s\n' '{"daemon":{"listen":"127.0.0.1:6768","relay":{"enabled":false}},"pluginsEnabled":true}' > "$WORKBOARD_INTEGRATION_HOME/config.json"
```

Start the target Paseo version with `PASEO_HOME` set to that exact home, then install the
checkout there and confirm it is running:

```sh
PASEO_HOME="$WORKBOARD_INTEGRATION_HOME" paseo daemon start --home "$WORKBOARD_INTEGRATION_HOME"
paseo plugin install --home "$WORKBOARD_INTEGRATION_HOME" .
paseo status --home "$WORKBOARD_INTEGRATION_HOME" --json
```

Run the suite from the repository root:

```sh
npm run test:integration
```

The harness rejects a home outside a system temporary directory, a missing or
incorrect marker, a non-loopback listener, an unreported daemon version, or a
non-running Workboard plugin. It does not start, stop, or fall back to another
daemon during the test run.

During setup the suite installs `fixture-provider` only into this marked home.
The provider supplies deterministic history and responses for the tests; it
does not make model requests. The suite creates test workspaces and changes
fixture-provider state, so never use a personal or shared daemon home.

## Stop and remove the temporary home

Stop the isolated daemon before removing its home. If the stop command fails,
keep the directory for diagnosis and do not remove it while a daemon may still
be using it.

```sh
if paseo daemon stop --home "$WORKBOARD_INTEGRATION_HOME"; then
  rm -rf "$WORKBOARD_INTEGRATION_HOME"
fi
```

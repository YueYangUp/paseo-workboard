import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const pkg = readJson("package.json");
const manifest = readJson("paseo-plugin.json");
const lock = readJson("package-lock.json");
assert.equal(manifest.id, "paseo-workboard");
assert.equal(pkg.name, manifest.id);
assert.notEqual(pkg.private, true);
assert.match(pkg.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
assert.notEqual(pkg.version, "0.0.0");
assert.equal(lock.version, pkg.version);
assert.equal(lock.packages[""].version, pkg.version);
assert.equal(pkg.publishConfig.access, "public");
assert.equal(pkg.publishConfig.registry, "https://registry.npmjs.org/");
assert.match(manifest.requirements.paseo, /^>=\d+\.\d+\.\d+(?:-[\w.-]+)?$/);
assert.match(readFileSync("README.md", "utf8"), /^## Installation$/m);
assert.match(readFileSync("README.md", "utf8"), /^## Limitations$/m);

const npm = process.env.npm_execpath;
assert.ok(npm, "Run this check with npm run check:package");
const [packed] = JSON.parse(
  execFileSync(
    process.execPath,
    [npm, "pack", "--dry-run", "--json", "--ignore-scripts"],
    {
      encoding: "utf8",
    },
  ),
);
assert.equal(packed.name, pkg.name);
assert.equal(packed.version, pkg.version);
const expected = [
  "package.json",
  "paseo-plugin.json",
  "index.client.tsx",
  "index.server.ts",
  "LICENSE",
  "README.md",
  "README.zh-CN.md",
  "OVERVIEW.md",
  "OVERVIEW.zh-CN.md",
  "images/icon.png",
  ...["en", "zh-CN"].flatMap((language) => [
    ...[
      "workboard",
      "list",
      "filters",
      "settings",
      "project-priority",
      "priority-settings",
    ].map((name) => `images/${name}-${language}.png`),
    ...["views-filter", "move-undo"].map(
      (name) => `images/${name}-${language}.gif`,
    ),
  ]),
  ...["client", "server", "shared"].flatMap((directory) =>
    readdirSync(directory, { recursive: true })
      .filter((file) => /\.tsx?$/.test(file))
      .map((file) => `${directory}/${file.replaceAll("\\", "/")}`),
  ),
].sort();
assert.equal(manifest.icon, "images/icon.png");
assert.ok(manifest.media.length > 0);
for (const asset of [manifest.icon, ...manifest.media]) {
  assert.ok(expected.includes(asset), `Unapproved listing asset: ${asset}`);
  const bytes = readFileSync(asset);
  if (asset.endsWith(".png")) {
    assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  } else {
    assert.match(bytes.subarray(0, 6).toString(), /^GIF8[79]a$/);
  }
}
const icon = readFileSync(manifest.icon);
assert.equal(icon.readUInt32BE(16), 512);
assert.equal(icon.readUInt32BE(20), 512);
assert.deepEqual(
  packed.files.map((file) => file.path).sort(),
  expected,
  "Package must include all runtime sources and only the approved public files",
);
console.log(
  `${packed.name}@${packed.version}: ${expected.length} files, ${packed.size} bytes; package checks passed.`,
);

import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import {
  CLOCK_OFFSET_ENV,
  CLOCK_FILE_ENV,
  CLOCK_FILE_NAME,
  workboardClock,
} from "../server/test-clock";

const MARKER = "paseo-workboard-integration-v1\n";
const MARKER_NAME = ".paseo-workboard-integration";
// Resolved on the running platform, so it is absolute and uses its own separators.
const HOME = path.resolve(tmpdir(), "fixture-home");
const read =
  (content: string | null, home = HOME, join = path.join) =>
  (file: string) => {
    expect(file).toBe(join(home, MARKER_NAME));
    if (content === null) throw new Error("ENOENT");
    return content;
  };
const now = () => 1_000;
const temporary = () => true;
const env = (extra: Record<string, string>, home = HOME) => ({
  PASEO_HOME: home,
  ...extra,
});
const offset = { [CLOCK_OFFSET_ENV]: "5000" };

it("shifts the clock only with both the offset variable and the integration marker", () => {
  expect(workboardClock(env(offset), read(MARKER), now, temporary).now()).toBe(
    6_000,
  );
});
it("keeps the real clock when only the offset variable is set", () => {
  expect(workboardClock(env(offset), read(null), now, temporary).now()).toBe(
    1_000,
  );
  expect(
    workboardClock({ [CLOCK_OFFSET_ENV]: "5000" }, read(MARKER), now).now(),
  ).toBe(1_000);
});
it("keeps the real clock when only the marker exists", () => {
  expect(workboardClock(env({}), read(MARKER), now, temporary).now()).toBe(
    1_000,
  );
});
it("keeps the real clock when the marker content is wrong or the offset is invalid", () => {
  expect(
    workboardClock(env(offset), read("other\n"), now, temporary).now(),
  ).toBe(1_000);
  for (const bad of ["-5", "1e9", "abc", "", "1.5"])
    expect(
      workboardClock(
        env({ [CLOCK_OFFSET_ENV]: bad }),
        read(MARKER),
        now,
        temporary,
      ).now(),
    ).toBe(1_000);
  expect(
    workboardClock(
      { ...offset, PASEO_HOME: "relative/home" },
      () => MARKER,
      now,
      temporary,
    ).now(),
  ).toBe(1_000);
});
it("reports the offset it applies, and zero otherwise", () => {
  expect(
    workboardClock(env(offset), read(MARKER), now, temporary).offsetMs,
  ).toBe(5_000);
  expect(workboardClock(env(offset), read(null), now, temporary).offsetMs).toBe(
    0,
  );
  expect(workboardClock(env({}), read(MARKER), now, temporary).offsetMs).toBe(
    0,
  );
});
it("keeps the real clock outside a temporary directory", () => {
  expect(
    workboardClock(env(offset), read(MARKER), now, () => false).now(),
  ).toBe(1_000);
  // The real check refuses a home outside the system temporary directory (a parent of it,
  // such as the user's home, is outside it).
  expect(
    workboardClock(
      env(offset, path.resolve(homedir())),
      () => MARKER,
      now,
    ).now(),
  ).toBe(1_000);
});
it("holds under Windows path semantics", () => {
  const home = String.raw`C:\Users\x\AppData\Local\Temp\paseo-workboard.AbC123`;
  const win = path.win32;
  expect(win.isAbsolute(home)).toBe(true);
  expect(
    workboardClock(
      env(offset, home),
      read(MARKER, home, win.join),
      now,
      temporary,
      win,
    ).now(),
  ).toBe(6_000);
  // A relative path is refused under Windows semantics as well.
  expect(
    workboardClock(
      env(offset, String.raw`Users\x\Temp\paseo-workboard.AbC123`),
      () => MARKER,
      now,
      temporary,
      win,
    ).now(),
  ).toBe(1_000);
  // And the wrong marker still refuses.
  expect(
    workboardClock(
      env(offset, home),
      read("other\n", home, win.join),
      now,
      temporary,
      win,
    ).now(),
  ).toBe(1_000);
});

it("advances an explicitly enabled temporary clock and reports the same offset", () => {
  let content = "6000";
  const clock = workboardClock(
    env({ ...offset, [CLOCK_FILE_ENV]: "1" }),
    (file) => {
      if (file === path.join(HOME, MARKER_NAME)) return MARKER;
      expect(file).toBe(path.join(HOME, CLOCK_FILE_NAME));
      if (content === "missing") throw new Error("ENOENT");
      return content;
    },
    now,
    temporary,
  );
  expect(clock.now()).toBe(7000);
  expect(clock.offsetMs).toBe(6000);
  content = "9000";
  expect(clock.offsetMs).toBe(9000);
  expect(clock.now()).toBe(10000);
  for (const invalid of ["", "partial", "-1", "1.5", "8000", "missing"]) {
    content = invalid;
    expect(clock.now()).toBe(10000);
    expect(clock.offsetMs).toBe(9000);
  }
});
it("never reads a clock file without the explicit flag and existing clock guards", () => {
  for (const [extra, marker, isTemporary] of [
    [offset, MARKER, true],
    [{ ...offset, [CLOCK_FILE_ENV]: "1" }, "wrong", true],
    [{ ...offset, [CLOCK_FILE_ENV]: "1" }, MARKER, false],
    [{ [CLOCK_FILE_ENV]: "1" }, MARKER, true],
  ] as const) {
    const clock = workboardClock(
      env(extra),
      read(marker),
      now,
      () => isTemporary,
    );
    expect(clock.now()).toBe(CLOCK_FILE_ENV in extra ? 1000 : 6000);
  }
});

import { readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** Names the integration marker that `tests/integration/README.md` writes into a temporary home. */
const MARKER_NAME = ".paseo-workboard-integration";
const MARKER_VALUE = "paseo-workboard-integration-v1";
export const CLOCK_FILE_ENV = "WORKBOARD_TEST_CLOCK_FILE";
export const CLOCK_FILE_NAME = ".workboard-clock-offset-ms";
export const CLOCK_OFFSET_ENV = "WORKBOARD_TEST_CLOCK_OFFSET_MS";

/** The home must be a disposable one: inside the system temporary directory. */
function inTemporaryDirectory(home: string): boolean {
  try {
    const real = realpathSync(home);
    return [tmpdir(), "/tmp"].some((directory) => {
      try {
        return real.startsWith(realpathSync(directory) + path.sep);
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

/**
 * The clock Workboard runs on. It is the real clock unless a test asks for an offset, and a
 * test can ask only inside the marked integration home: the offset variable alone is never
 * enough, so a stray variable cannot make archive decisions run in the future for a personal
 * daemon. Any unmet condition silently falls back to the real clock.
 */
export function workboardClock(
  env: Record<string, string | undefined> = process.env,
  readMarker: (file: string) => string = (file) => readFileSync(file, "utf8"),
  real: () => number = Date.now,
  temporary: (home: string) => boolean = inTemporaryDirectory,
  paths: Pick<typeof path, "isAbsolute" | "join"> = path,
): { now: () => number; offsetMs: number } {
  const realClock = { now: real, offsetMs: 0 };
  const raw = env[CLOCK_OFFSET_ENV];
  const home = env.PASEO_HOME;
  if (
    !raw ||
    !/^\d{1,13}$/.test(raw) ||
    !home ||
    !paths.isAbsolute(home) ||
    !temporary(home)
  )
    return realClock;
  try {
    if (readMarker(paths.join(home, MARKER_NAME)).trim() !== MARKER_VALUE)
      return realClock;
  } catch {
    return realClock;
  }
  let offsetMs = Number(raw);
  const offset = () => {
    if (env[CLOCK_FILE_ENV] === "1") {
      try {
        const value = readMarker(paths.join(home, CLOCK_FILE_NAME)).trim();
        // Retain the last valid offset on partial writes, deletion or backward steps.
        if (/^\d{1,13}$/.test(value))
          offsetMs = Math.max(offsetMs, Number(value));
      } catch {
        /* An absent file keeps the last valid clock. */
      }
    }
    return offsetMs;
  };
  return {
    now: () => real() + offset(),
    get offsetMs() {
      return offset();
    },
  };
}

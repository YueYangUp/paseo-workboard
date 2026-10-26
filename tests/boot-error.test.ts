import type { PluginServerContext } from "@getpaseo/plugin/server";
import { afterEach, expect, it, vi } from "vitest";
import contribute, { classifyBootFailure } from "../index.server";
import {
  InvalidStorageDataError,
  UnsupportedStorageVersionError,
  migrateData,
} from "../shared/migrations";
import { DATA_SCHEMA_VERSION, dataSchema } from "../shared/model";
import { snapshotRpc } from "../shared/rpc";
import { PaseoCompat } from "../server/paseo-compat";
import { PaseoHost } from "../server/host";
import { strings } from "../client/strings";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it.each([new UnsupportedStorageVersionError(), new InvalidStorageDataError()])(
  "classifies deterministic data failures",
  (error) => {
    expect(classifyBootFailure(error)).toEqual({
      deterministic: true,
      error: error.message,
    });
    for (const language of ["en", "zh"] as const)
      expect(strings(language).bootErrors).toHaveProperty(error.message);
  },
);
it("keeps connection failures transient", () => {
  expect(classifyBootFailure(new Error("host not ready"))).toEqual({
    deterministic: false,
    error: "host not ready",
  });
  expect(classifyBootFailure("connection reset")).toEqual({
    deterministic: false,
    error: "connection reset",
  });
});

function startup(read: () => Promise<unknown>) {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(PaseoCompat.prototype, "installBootstrap").mockReturnValue(
    async () => ({}) as never,
  );
  vi.spyOn(PaseoCompat.prototype, "identity").mockResolvedValue({
    serverId: "host",
    version: "fixture",
  });
  const inventory = vi
    .spyOn(PaseoHost.prototype, "inventory")
    .mockResolvedValue({ workspaces: [], agents: [], projects: [] });
  let change: Parameters<PaseoCompat["onChange"]>[0] | undefined;
  vi.spyOn(PaseoCompat.prototype, "onChange").mockImplementation((listener) => {
    change = listener;
    return () => {
      change = undefined;
    };
  });
  const handlers = new Map<string, () => unknown>();
  const write = vi
    .spyOn(PaseoCompat.prototype, "invoke")
    .mockImplementation(async (_action, input) => ({
      status: "saved",
      revision: "next",
      values: (input as { values: unknown }).values,
    }));
  const registered = vi.fn(read);
  const registerSettings = vi.fn((_definition: unknown) => ({
    read: registered,
  }));
  const server = {
    registerSettings,
    handle: (rpc: { name: string }, handler: () => unknown) =>
      handlers.set(rpc.name, handler),
  } as unknown as PluginServerContext;
  const stop = contribute(server);
  return {
    read: registered,
    registerSettings,
    inventory,
    write,
    stop,
    change: (type = "changed") => change?.(type, { workspaceId: "w" }),
    snapshot: () => snapshotRpc.output.parse(handlers.get(snapshotRpc.name)!()),
  };
}

it.each([
  { status: "invalid", revision: "r", error: "unsupported-storage-version" },
  { status: "invalid", revision: "r", error: "Validation failed" },
  {
    status: "ready",
    revision: "r",
    values: { schemaVersion: DATA_SCHEMA_VERSION + 1 },
  },
  {
    status: "ready",
    revision: "r",
    values: { schemaVersion: DATA_SCHEMA_VERSION, tasks: "corrupt" },
  },
])(
  "stops startup retries for invalid stored data and exposes a localized board error: %j",
  async (result) => {
    const test = startup(async () => result);
    try {
      await vi.advanceTimersByTimeAsync(0);
      const code =
        (result.status === "invalid" &&
          result.error === "unsupported-storage-version") ||
        (result.status === "ready" &&
          result.values?.schemaVersion === DATA_SCHEMA_VERSION + 1)
          ? "unsupported-storage-version"
          : "invalid-storage-data";
      expect(test.snapshot()).toMatchObject({ connected: false, error: code });
      test.change();
      test.change("disconnected");
      await vi.advanceTimersByTimeAsync(120_000);
      expect(test.read).toHaveBeenCalledTimes(1);
      expect(test.inventory).not.toHaveBeenCalled();
      expect(test.write).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      expect(test.snapshot().error).toBe(code);
    } finally {
      test.stop();
    }
  },
);

it("stops retries when migration throws a deterministic error", async () => {
  const test = startup(async () => migrateData({}, 99));
  try {
    await vi.advanceTimersByTimeAsync(30_000);
    expect(test.read).toHaveBeenCalledTimes(1);
    expect(test.snapshot().error).toBe("unsupported-storage-version");
  } finally {
    test.stop();
  }
});

it("retries a transient read failure after ten seconds and recovers", async () => {
  let calls = 0;
  const test = startup(async () => {
    if (++calls === 1) throw new Error("Connection reset");
    return { status: "ready", revision: "r", values: dataSchema.parse({}) };
  });
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(test.snapshot()).toMatchObject({
      connected: false,
      error: "Connection reset",
    });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(test.read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(test.read).toHaveBeenCalledTimes(2);
    expect(test.snapshot()).toMatchObject({ connected: true, error: null });
  } finally {
    test.stop();
  }
});

it("registers the current schema and migration that upgrade stored v6 data", async () => {
  const test = startup(async () => ({
    status: "ready",
    revision: "r",
    values: dataSchema.parse({}),
  }));
  try {
    const definition = test.registerSettings.mock.calls[0][0] as unknown as {
      version: number;
      migrate(values: unknown, fromVersion: number): unknown;
    };
    expect(definition.version).toBe(DATA_SCHEMA_VERSION);
    expect(definition.migrate({ schemaVersion: 6 }, 6)).toMatchObject({
      schemaVersion: DATA_SCHEMA_VERSION,
      settings: {
        archiveAfterDays: 30,
        defaultDraftGroup: null,
        defaultStartGroup: null,
      },
      tasks: [],
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(test.snapshot().connected).toBe(true);
  } finally {
    test.stop();
  }
});

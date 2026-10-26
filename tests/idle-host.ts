import { vi } from "vitest";
import type { PaseoApi, SubscriptionObserver } from "@getpaseo/client";
import { PaseoHost } from "../server/host";
import type { PaseoCompat } from "../server/paseo-compat";
import { settingsSchema, type Data } from "../shared/model";
import { Workboard } from "../server/workboard";
import { fixture, workspace } from "./fixtures";

export type FakeAgent = {
  id: string;
  workspaceId: string;
  title: string;
  updatedAt: string;
  lastUserMessageAt: string | null;
  archivedAt: string | null;
  pendingPermissions: never[];
  attentionReason: null;
  status: "idle" | "running";
  activeTurn: null;
  lastError: null;
  requiresAttention: false;
};
export type FakeChild = {
  id: string;
  title: string | null;
  status: "running" | "completed" | "failed" | "canceled";
  updatedAt: string;
};
export const agent = (
  id: string,
  updatedAt: string,
  extra: Partial<FakeAgent> = {},
): FakeAgent => ({
  id,
  workspaceId: "old",
  title: id,
  updatedAt,
  lastUserMessageAt: updatedAt,
  archivedAt: null,
  pendingPermissions: [],
  attentionReason: null,
  status: "idle",
  activeTurn: null,
  lastError: null,
  requiresAttention: false,
  ...extra,
});
const page = <T>(entries: T[]) => ({
  entries,
  pageInfo: { nextCursor: null, hasMore: false },
});
const timelineOf = (entries: Array<{ timestamp: string; type: string }>) => ({
  epoch: "e",
  gap: false,
  staleCursor: false,
  error: null,
  hasOlder: false,
  startCursor: null,
  window: { maxSeq: entries.length },
  entries: entries.map(({ timestamp, type }) => ({
    timestamp,
    item: { type },
  })),
});

/**
 * A real PaseoHost and Workboard over a fake daemon whose per-agent requests are spied, so a
 * test can state exactly which agents a refresh or a recheck is allowed to wake.
 */
export function idleBoard(options: {
  agents: FakeAgent[];
  children?: Record<string, FakeChild[]>;
  /** Message times by agent id, or by `parent/child` for a provider child. */
  history?: Record<string, string[]>;
  data?: Partial<Data>;
  labels?: string[];
  /** Whether the Done and Canceled archive rules start enabled. Defaults to true. */
  archive?: boolean;
}) {
  const test = fixture({
    settings: settingsSchema.parse({
      archiveDoneEnabled: options.archive ?? true,
      archiveCanceledEnabled: options.archive ?? true,
      pinInProgressWorkspaces: false,
    }),
    ...options.data,
  });
  let clock = test.now();
  const agents = options.agents;
  const children = options.children ?? {};
  const history = options.history ?? {};
  const observers: SubscriptionObserver<unknown>[] = [];
  const subscribe = () => ({
    ready: Promise.resolve({ subscriptionId: "s" }),
    subscriptionId: "s",
    release: async () => {},
    subscribe: (observer: SubscriptionObserver<unknown>) => {
      observers.push(observer);
      observer.snapshot({ subscriptionId: "s" });
      return () => {};
    },
  });
  const live = [workspace("old", undefined, options.labels ?? ["task:done"])];
  const refetch = vi.fn(async (id: string) =>
    timelineOf(
      (history[id] ?? []).map((timestamp) => ({
        timestamp,
        type: "assistant_message",
      })),
    ),
  );
  const archive = vi.fn(async (id: string) => {
    live.splice(0, live.length, ...live.filter((w) => w.id !== id));
    return { archivedAt: new Date(clock).toISOString(), error: null };
  });
  const api = {
    observeEvents: subscribe,
    workspaces: {
      list: async (o: { subscribe?: object }) => ({
        ...page(live),
        subscription: o.subscribe ? subscribe() : undefined,
      }),
      ref: (id: string) => ({
        refresh: async () => live.find((w) => w.id === id) ?? null,
      }),
      archive,
    },
    agents: {
      list: async (o: { subscribe?: object }) => ({
        ...page(agents.map((a) => ({ agent: a }))),
        subscription: o.subscribe ? subscribe() : undefined,
      }),
      ref: (id: string) => ({
        timeline: { refetch: () => refetch(id) },
      }),
    },
    terminals: { list: async () => page([]) },
    projects: { list: async () => ({ projects: [] }) },
  };
  const subagents = vi.fn(async (parent: string) => children[parent] ?? []);
  const subagentTimeline = vi.fn(
    (parent: string, child: string) => async () =>
      timelineOf(
        (history[`${parent}/${child}`] ?? []).map((timestamp) => ({
          timestamp,
          type: "assistant_message",
        })),
      ),
  );
  const compat = { subagents, subagentTimeline } as unknown as PaseoCompat;
  // A restart keeps the daemon and the stored data but loses every in-memory cache.
  const build = () => {
    const host = new PaseoHost(
      api as unknown as PaseoApi,
      compat,
      { serverId: "fixture-host", version: "0.12.0" },
      (id, agentsChanged) =>
        agentsChanged ? board.agentsChanged(id) : board.changed(id),
    );
    // Git and terminal safety are not under test; the fake workspace has no directory.
    host.safety = async () => null;
    const board: Workboard = new Workboard(host, test.store, () => clock);
    return { host, board };
  };
  let { host, board } = build();
  const calls = () => ({
    timelines: refetch.mock.calls.map(([id]) => id),
    lists: subagents.mock.calls.map(([id]) => id),
    childTimelines: subagentTimeline.mock.calls.map(
      ([parent, child]) => `${parent}/${child}`,
    ),
  });
  return {
    ...test,
    get board() {
      return board;
    },
    get host() {
      return host;
    },
    restart: () => {
      board.dispose();
      ({ host, board } = build());
      return board;
    },
    api,
    agents,
    children,
    history,
    observers,
    archive,
    refetch,
    subagents,
    subagentTimeline,
    calls,
    advance: (ms: number) => (clock += ms),
    clearCalls: () => {
      refetch.mockClear();
      subagents.mockClear();
      subagentTimeline.mockClear();
    },
  };
}

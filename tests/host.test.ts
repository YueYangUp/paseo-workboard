import { expect, it, vi } from "vitest";
import type {
  PaseoApi,
  PaseoAgent,
  OwnedSubscription,
  SubscriptionObserver,
} from "@getpaseo/client";
import { allPages, PaseoHost } from "../server/host";
import type { TimelineReader } from "../server/conversations";
import type { PaseoCompat } from "../server/paseo-compat";
import { Store } from "../server/store";
import { Workboard } from "../server/workboard";
import { settingsSchema } from "../shared/model";
import { fixture, workspace } from "./fixtures";
import type { Inventory, ProviderChild, Workspace } from "../server/host";

it("reads every page and rejects a cursor loop instead of silently truncating", async () => {
  expect(
    await allPages(async (cursor) =>
      cursor
        ? { entries: [201], pageInfo: { hasMore: false, nextCursor: null } }
        : {
            entries: Array.from({ length: 200 }, (_, i) => i + 1),
            pageInfo: { hasMore: true, nextCursor: "second" },
          },
    ),
  ).toHaveLength(201);
  await expect(
    allPages(async () => ({
      entries: [],
      pageInfo: { hasMore: true, nextCursor: "loop" },
    })),
  ).rejects.toThrow("pagination");
});
it("keeps directory and subagent subscriptions across inventories, overlays off-page changes and refreshes restored snapshots", async () => {
  const observers: SubscriptionObserver<unknown>[] = [];
  const release = vi.fn(async () => {});
  const subscribe = () =>
    ({
      ready: Promise.resolve({ subscriptionId: "s" }),
      subscriptionId: "s",
      release,
      subscribe: (observer: SubscriptionObserver<unknown>) => {
        observers.push(observer);
        observer.snapshot({ subscriptionId: "s" });
        return () => {};
      },
    }) as OwnedSubscription<unknown>;
  const rows = Array.from({ length: 201 }, (_, i) => ({
    ...workspace(String(i)),
    syncSeq: 1,
  }));
  let subscriptionRequests = 0;
  const api = {
    observeEvents: subscribe,
    workspaces: {
      list: async (options: {
        subscribe?: object;
        page?: { cursor?: string };
      }) => {
        if (options.subscribe) {
          subscriptionRequests++;
          return {
            entries: rows.slice(0, 200),
            subscription: subscribe(),
            pageInfo: { nextCursor: "tail", hasMore: true },
          };
        }
        if (options.page?.cursor) {
          observers[0].update({
            type: "workspace_update",
            payload: {
              kind: "upsert",
              workspace: {
                ...rows[200],
                name: "Fresh beyond page one",
                forge: "gitlab",
                githubRuntime: {
                  pullRequest: {
                    number: 42,
                    url: "https://code.example/team/repo/-/merge_requests/42",
                    title: "Updated MR",
                    state: "OPEN",
                    baseRefName: "main",
                    headRefName: "fix",
                    isMerged: false,
                  },
                },
                syncSeq: 2,
              },
            },
          } as Parameters<(typeof observers)[0]["update"]>[0]);
          return {
            entries: rows.slice(200),
            pageInfo: { nextCursor: null, hasMore: false },
          };
        }
        return {
          entries: rows.slice(0, 200),
          pageInfo: { nextCursor: "tail", hasMore: true },
        };
      },
    },
    agents: {
      list: async (options: { subscribe?: object }) => {
        if (options.subscribe) subscriptionRequests++;
        return {
          entries: [],
          subscription: options.subscribe ? subscribe() : undefined,
          pageInfo: { nextCursor: null, hasMore: false },
        };
      },
    },
    projects: { list: async () => ({ projects: [] }) },
  };
  const changed = vi.fn();
  const host = new PaseoHost(
    api as unknown as PaseoApi,
    {} as PaseoCompat,
    { serverId: "h", version: "0.9.1" },
    changed,
  );
  try {
    const first = await host.inventory();
    expect(first.workspaces).toHaveLength(201);
    expect(first.workspaces[200].name).toBe("Fresh beyond page one");
    expect(first.workspaces[200]).toMatchObject({
      forge: "gitlab",
      githubRuntime: { pullRequest: { number: 42, title: "Updated MR" } },
    });
    await host.inventory();
    expect(subscriptionRequests).toBe(2);
    expect(release).not.toHaveBeenCalled();
    changed.mockClear();
    observers[0].snapshot({});
    expect(changed).toHaveBeenCalledTimes(1);
  } finally {
    host.dispose();
  }
  expect(release).toHaveBeenCalledTimes(3);
});

function providerHost(
  parent:
    | Record<string, unknown>
    | Record<string, unknown>[]
    | (() => Promise<Record<string, unknown>[]>),
  compat: PaseoCompat,
  changed: (workspaceId?: string, agentsChanged?: boolean) => void = vi.fn(),
  observers: SubscriptionObserver<unknown>[] = [],
  timeline: TimelineReader = async () => ({
    epoch: "epoch-empty",
    gap: false,
    staleCursor: false,
    error: null,
    hasOlder: false,
    startCursor: null,
    window: { maxSeq: 0 },
    entries: [],
  }),
  workspaces: () => Workspace[] = () => [workspace("w1")],
) {
  const release = vi.fn(async () => {});
  const subscribe = () =>
    ({
      ready: Promise.resolve({ subscriptionId: "s" }),
      subscriptionId: "s",
      release,
      subscribe: (observer: SubscriptionObserver<unknown>) => {
        observers.push(observer);
        observer.snapshot({ subscriptionId: "s" });
        return () => {};
      },
    }) as OwnedSubscription<unknown>;
  const api = {
    observeEvents: subscribe,
    workspaces: {
      list: async (options: { subscribe?: object }) => ({
        entries: workspaces(),
        subscription: options.subscribe ? subscribe() : undefined,
        pageInfo: { nextCursor: null, hasMore: false },
      }),
    },
    agents: {
      list: async (options: { subscribe?: object }) => ({
        entries: (typeof parent === "function"
          ? await parent()
          : Array.isArray(parent)
            ? parent
            : [parent]
        ).map((agent) => ({
          agent,
        })),
        subscription: options.subscribe ? subscribe() : undefined,
        pageInfo: { nextCursor: null, hasMore: false },
      }),
      ref: () => ({ timeline: { refetch: timeline } }),
    },
    projects: { list: async () => ({ projects: [] }) },
  };
  return new PaseoHost(
    api as unknown as PaseoApi,
    compat,
    { serverId: "h", version: "0.9.1" },
    changed,
  );
}

const parentAgent = {
  id: "parent",
  workspaceId: "w1",
  title: "Parent",
  updatedAt: "2026-08-03T00:00:00.000Z",
  lastUserMessageAt: null,
  archivedAt: null,
  pendingPermissions: [],
  attentionReason: null,
  status: "running",
  activeTurn: null,
  lastError: null,
  requiresAttention: false,
};

it.each([
  { activity: "attention", status: "idle", requiresAttention: true },
  { activity: "waiting", status: "idle", attentionReason: "permission" },
  { activity: "error", status: "error" },
  { activity: "running", status: "running" },
])(
  "projects delegated $activity from inventory and restores workspace activity when the label is removed",
  async ({ activity, ...source }) => {
    const test = fixture();
    const delegated = {
      ...parentAgent,
      id: "delegated",
      ...source,
      labels: { "paseo.parent-agent-id": "parent" } as Record<string, string>,
    };
    const native = providerHost(
      [{ ...parentAgent, status: "idle" }, delegated],
      {
        subagents: async () => [],
      } as unknown as PaseoCompat,
    );
    const board = new Workboard(
      {
        ...test.host,
        inventory: native.inventory.bind(native),
        dispose: () => native.dispose(),
      },
      test.store,
      test.now,
    );
    try {
      const inventory = await native.inventory();
      expect(
        inventory.agents.find((agent) => agent.id === delegated.id),
      ).toMatchObject({
        delegatedBy: "parent",
        activity,
      });
      await board.start();
      expect(board.snapshot().cards[0].activity).toBe("idle");
      expect(
        board
          .snapshot()
          .cards[0].agents.find((agent) => agent.id === delegated.id),
      ).toMatchObject({ activity });

      delegated.labels = {};
      const refreshed = await native.inventory();
      expect(
        refreshed.agents.find((agent) => agent.id === delegated.id)
          ?.delegatedBy,
      ).toBeUndefined();
      await board.refresh();
      expect(board.snapshot().cards[0].activity).toBe(activity);
    } finally {
      board.dispose();
    }
  },
);

it.each([
  {
    change: "addition",
    before: undefined,
    after: "parent",
    initialActivity: "attention",
    activity: "idle",
  },
  {
    change: "removal",
    before: "parent",
    after: undefined,
    initialActivity: "idle",
    activity: "attention",
  },
])(
  "applies a delegation-label $change received while inventory is in flight",
  async ({ before, after, initialActivity, activity }) => {
    const test = fixture();
    const delegated: PaseoAgent = {
      ...parentAgent,
      id: "delegated",
      status: "idle",
      provider: "fixture",
      cwd: "/fixture",
      model: null,
      createdAt: parentAgent.updatedAt,
      currentModeId: null,
      availableModes: [],
      persistence: null,
      capabilities: {
        supportsStreaming: false,
        supportsSessionPersistence: false,
        supportsDynamicModes: false,
        supportsMcpServers: false,
        supportsReasoningStream: false,
        supportsToolInvocations: false,
      },
      lastError: undefined,
      requiresAttention: true,
      labels: before ? { "paseo.parent-agent-id": before } : {},
    };
    const listed = [{ ...parentAgent, status: "idle" }, delegated];
    const list = vi.fn(async (): Promise<Record<string, unknown>[]> => listed);
    const observers: SubscriptionObserver<unknown>[] = [];
    const native = providerHost(
      list,
      { subagents: async () => [] } as unknown as PaseoCompat,
      vi.fn(),
      observers,
    );
    let projected: Inventory | undefined;
    const board = new Workboard(
      {
        ...test.host,
        inventory: async () => (projected = await native.inventory()),
        dispose: () => native.dispose(),
      },
      test.store,
      test.now,
    );
    try {
      await board.start();
      expect(board.snapshot().cards[0].activity).toBe(initialActivity);

      const entered = deferred<void>();
      const response = deferred<Record<string, unknown>[]>();
      list.mockImplementationOnce(() => {
        entered.resolve();
        return response.promise;
      });
      const refreshing = board.refresh();
      await entered.promise;
      observers[1].update({
        type: "agent_update",
        payload: {
          kind: "upsert",
          agent: {
            ...delegated,
            updatedAt: "2026-08-04T00:00:00.000Z",
            labels: after ? { "paseo.parent-agent-id": after } : {},
          },
        },
      });
      response.resolve(listed);
      await refreshing;

      expect(
        projected?.agents.find((agent) => agent.id === delegated.id)
          ?.delegatedBy,
      ).toBe(after);
      expect(board.snapshot().cards[0].activity).toBe(activity);
      expect(
        board
          .snapshot()
          .cards[0].agents.find((agent) => agent.id === delegated.id),
      ).toMatchObject({ activity: "attention" });
    } finally {
      board.dispose();
    }
  },
);

it.each([
  { status: "error", attentionReason: null },
  { status: "idle", attentionReason: "error" },
  { status: "idle", attentionReason: null },
])("preserves the native error source in the inventory: %j", async (source) => {
  const host = providerHost(
    { ...parentAgent, ...source, lastError: "Previous turn failed" },
    { subagents: async () => [] } as unknown as PaseoCompat,
  );
  try {
    const inventory = await host.inventory();
    expect(inventory.agents[0]).toMatchObject({
      ...source,
      activity: "error",
      lastError: "Previous turn failed",
    });
  } finally {
    host.dispose();
  }
});

function invalidateChildListing(
  observers: SubscriptionObserver<unknown>[],
  event: "snapshot" | "error" | "upsert" | "remove",
) {
  const observer = observers[2];
  if (event === "snapshot") observer.snapshot({});
  else if (event === "error")
    observer.error!(new Error("Subscription request failed"));
  else
    observer.update({
      type: "agent.provider_subagents.update",
      payload:
        event === "upsert"
          ? { kind: event, subagent: { parentAgentId: "parent", id: "child" } }
          : { kind: event, parentAgentId: "parent", subagentId: "child" },
    } as Parameters<typeof observer.update>[0]);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it.each(["snapshot", "error"] as const)(
  "rechecks child inventory after subscription %s before automatic archive",
  async (event) => {
    const test = fixture({
      settings: settingsSchema.parse({ archiveDoneEnabled: true }),
    });
    test.inventory.workspaces.push(workspace("w1", "Task", ["task:todo"]));
    const old = "2026-08-02T00:00:00.000Z";
    const recent = "2026-09-22T00:00:00.000Z";
    const page = (timestamp: string) => ({
      epoch: "epoch",
      gap: false,
      staleCursor: false,
      error: null,
      hasOlder: false,
      startCursor: null,
      window: { maxSeq: 1 },
      entries: [{ timestamp, item: { type: "assistant_message" } }],
    });
    let children: ProviderChild[] = [];
    const subagents = vi.fn(async () => children);
    const observers: SubscriptionObserver<unknown>[] = [];
    const native = providerHost(
      { ...parentAgent, lastUserMessageAt: old },
      {
        subagents,
        subagentTimeline: () => async () => page(recent),
      } as unknown as PaseoCompat,
      vi.fn(),
      observers,
      async () => page(old),
      () => test.inventory.workspaces,
    );
    const host = {
      ...test.host,
      inventory: native.inventory.bind(native),
      conversation: native.conversation.bind(native),
      recheckAgents: native.recheckAgents.bind(native),
      dispose: () => native.dispose(),
    };
    const board = new Workboard(host, test.store, test.now);
    try {
      await board.start();
      expect(subagents).toHaveBeenCalledTimes(1);
      // A child arrived while events were unavailable, without changing parent.updatedAt.
      children = [
        { id: "child", title: "Child", status: "completed", updatedAt: recent },
      ];
      invalidateChildListing(observers, event);
      test.inventory.workspaces[0].labels = ["task:done"];
      await board.refresh();
      expect(host.archive).not.toHaveBeenCalled();
      expect(board.snapshot().cards[0].conversationGateAt).toBe(recent);
      expect(subagents).toHaveBeenCalledTimes(2);
    } finally {
      board.dispose();
    }
  },
);

it.each(["snapshot", "error", "upsert", "remove"] as const)(
  "retains known children after %s and retries a failed listing after 60 seconds",
  async (event) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-23T00:00:00.000Z"));
    const old = "2026-08-02T00:00:00.000Z";
    const test = fixture({
      settings: settingsSchema.parse({ archiveDoneEnabled: true }),
    });
    test.inventory.workspaces.push(workspace("w1", "Task", ["task:todo"]));
    const children = [
      { id: "child", title: "Child", status: "completed", updatedAt: old },
    ];
    const subagents = vi.fn(async () => children);
    const timeline: TimelineReader = async () => ({
      epoch: "epoch",
      gap: false,
      staleCursor: false,
      error: null,
      hasOlder: false,
      startCursor: null,
      window: { maxSeq: 1 },
      entries: [{ timestamp: old, item: { type: "assistant_message" } }],
    });
    const observers: SubscriptionObserver<unknown>[] = [];
    // The parent stays live while the listing is retried, then rests: a resting parent is
    // listed only by the archive recheck, which is the third and last listing here.
    const parent = { ...parentAgent };
    const native = providerHost(
      parent,
      { subagents, subagentTimeline: () => timeline } as unknown as PaseoCompat,
      vi.fn(),
      observers,
      timeline,
      () => test.inventory.workspaces,
    );
    const host = {
      ...test.host,
      inventory: native.inventory.bind(native),
      conversation: native.conversation.bind(native),
      recheckAgents: native.recheckAgents.bind(native),
      dispose: () => native.dispose(),
    };
    const board = new Workboard(host, test.store, test.now);
    try {
      await board.start();
      invalidateChildListing(observers, event);
      subagents.mockRejectedValueOnce(new Error("Provider unavailable"));
      test.inventory.workspaces[0].labels = ["task:done"];
      await board.refresh();
      expect(host.archive).not.toHaveBeenCalled();
      expect(board.snapshot().cards[0]).toMatchObject({
        conversationGateEvidence: "unknown",
        lastConversationAt: old,
        dueAt: null,
      });
      expect(
        (await native.inventory()).agents.map((agent) => agent.id),
      ).toContain("parent/provider/child");
      vi.setSystemTime(new Date("2026-09-23T00:00:59.999Z"));
      await board.refresh();
      expect(subagents).toHaveBeenCalledTimes(2);
      expect(host.archive).not.toHaveBeenCalled();
      vi.setSystemTime(new Date("2026-09-23T00:01:00.000Z"));
      parent.status = "idle";
      await board.refresh();
      expect(subagents).toHaveBeenCalledTimes(3);
      expect(host.archive).toHaveBeenCalledExactlyOnceWith("w1");
    } finally {
      board.dispose();
      vi.useRealTimers();
    }
  },
);

it.each(["snapshot", "error", "upsert", "remove"] as const)(
  "rejects an in-flight child result invalidated by %s in both the inventory and cache",
  async (event) => {
    const started = deferred<void>();
    const listing = deferred<ProviderChild[]>();
    const subagents = vi
      .fn(
        async (): Promise<ProviderChild[]> => [
          {
            id: "child",
            title: "Child",
            status: "completed",
            updatedAt: "2026-09-22T00:00:00.000Z",
          },
        ],
      )
      .mockImplementationOnce(() => {
        started.resolve();
        return listing.promise;
      });
    const observers: SubscriptionObserver<unknown>[] = [];
    const host = providerHost(
      parentAgent,
      { subagents } as unknown as PaseoCompat,
      vi.fn(),
      observers,
    );
    try {
      const pending = host.inventory();
      await started.promise;
      invalidateChildListing(observers, event);
      listing.resolve([]);
      expect((await pending).agents[0].childEnumeration).toBe("unavailable");
      const current = await host.inventory();
      expect(current.agents[0].childEnumeration).toBe("complete");
      expect(current.agents.map((agent) => agent.id)).toContain(
        "parent/provider/child",
      );
      expect(subagents).toHaveBeenCalledTimes(2);
    } finally {
      host.dispose();
    }
  },
);

it.each(["snapshot", "error", "upsert", "remove"] as const)(
  "rejects an archive recheck's listing that %s invalidated while it was in flight",
  async (event) => {
    const started = deferred<void>();
    const listing = deferred<ProviderChild[]>();
    const stale: ProviderChild = {
      id: "child",
      title: "Child",
      status: "completed",
      updatedAt: "2026-09-22T00:00:00.000Z",
    };
    const subagents = vi
      .fn(async (): Promise<ProviderChild[]> => [])
      .mockImplementationOnce(() => {
        started.resolve();
        return listing.promise;
      });
    const observers: SubscriptionObserver<unknown>[] = [];
    // An idle parent is never listed by a refresh, so only the recheck lists it.
    const host = providerHost(
      { ...parentAgent, status: "idle" },
      { subagents } as unknown as PaseoCompat,
      vi.fn(),
      observers,
    );
    try {
      const before = await host.inventory();
      expect(subagents).not.toHaveBeenCalled();
      const pending = host.recheckAgents(before.agents);
      const outcome = pending.then(
        () => "listed",
        () => "rejected",
      );
      await started.promise;
      invalidateChildListing(observers, event);
      listing.resolve([stale]);
      // A response from before the invalidation is not a complete inventory...
      expect(await outcome).toBe("rejected");
      // ...and is not kept as one: the next refresh has no trace of it.
      const after = await host.inventory();
      expect(after.agents.map((agent) => agent.id)).not.toContain(
        "parent/provider/child",
      );
      // A later recheck lists again and succeeds.
      expect(
        (await host.recheckAgents(after.agents)).map((agent) => agent.id),
      ).toEqual(["parent"]);
      expect(subagents).toHaveBeenCalledTimes(2);
    } finally {
      host.dispose();
    }
  },
);

it("invalidates earlier parents when a subscription restores during a later parent's listing", async () => {
  const started = deferred<void>();
  const listing = deferred<ProviderChild[]>();
  const subagents = vi.fn(async (_id: string): Promise<ProviderChild[]> => []);
  const observers: SubscriptionObserver<unknown>[] = [];
  const parents = [{ ...parentAgent }];
  const host = providerHost(
    parents,
    { subagents } as unknown as PaseoCompat,
    vi.fn(),
    observers,
  );
  try {
    await host.inventory();
    parents.push({ ...parentAgent, id: "second" });
    subagents.mockImplementationOnce(() => {
      started.resolve();
      return listing.promise;
    });
    const pending = host.inventory();
    await started.promise;
    invalidateChildListing(observers, "snapshot");
    listing.resolve([]);
    expect(
      (await pending).agents.map((agent) => agent.childEnumeration),
    ).toEqual(["unavailable", "unavailable"]);
    subagents.mockImplementation(async (id) =>
      id === "parent"
        ? [
            {
              id: "child",
              title: "Child",
              status: "completed",
              updatedAt: "2026-09-22T00:00:00.000Z",
            },
          ]
        : [],
    );
    const current = await host.inventory();
    expect(
      current.agents.find((agent) => agent.id === "parent")?.childEnumeration,
    ).toBe("complete");
    expect(current.agents.map((agent) => agent.id)).toContain(
      "parent/provider/child",
    );
  } finally {
    host.dispose();
  }
});

it("does not restore provider sessions outside active workspaces", async () => {
  const subagents = vi.fn(async () => []);
  const host = providerHost(
    { ...parentAgent, workspaceId: "archived-workspace" },
    { subagents } as unknown as PaseoCompat,
  );
  try {
    const inventory = await host.inventory();
    expect(inventory.workspaces.map((w) => w.id)).toEqual(["w1"]);
    expect(subagents).not.toHaveBeenCalled();
  } finally {
    host.dispose();
  }
});

it("keeps an agent removal scoped to its last known workspace", async () => {
  const changed = vi.fn();
  const observers: SubscriptionObserver<unknown>[] = [];
  const host = providerHost(
    parentAgent,
    { subagents: async () => [] } as unknown as PaseoCompat,
    changed,
    observers,
  );
  try {
    await host.inventory();
    const remove = (agentId: string) =>
      observers[1].update({
        type: "agent_update",
        payload: { kind: "remove", agentId },
      } as Parameters<SubscriptionObserver<unknown>["update"]>[0]);
    remove("parent");
    expect(changed).toHaveBeenLastCalledWith("w1", true);
    remove("unknown");
    expect(changed).toHaveBeenLastCalledWith(undefined, true);
  } finally {
    host.dispose();
  }
});

it("merges provider-managed subagents and reads their projected conversation time", async () => {
  const read = vi.fn(async () => ({
    epoch: "epoch-1",
    gap: false,
    staleCursor: false,
    error: null,
    hasOlder: false,
    startCursor: null,
    window: { maxSeq: 2 },
    entries: [
      { timestamp: "2026-08-01T00:00:00.000Z", item: { type: "user_message" } },
      {
        timestamp: "2026-08-02T00:00:00.000Z",
        item: { type: "assistant_message" },
      },
    ],
  }));
  const compat = {
    subagents: vi.fn(async () => [
      {
        id: "child",
        title: "Worker",
        status: "completed",
        updatedAt: "2026-08-03T00:00:00.000Z",
      },
    ]),
    subagentTimeline: vi.fn(() => read),
  } as unknown as PaseoCompat;
  const host = providerHost(parentAgent, compat);
  try {
    const inventory = await host.inventory();
    const child = inventory.agents.find(
      (agent) => agent.id === "parent/provider/child",
    );
    expect(child).toMatchObject({
      workspaceId: "w1",
      parentAgentId: "parent",
      subagentId: "child",
      title: "Worker",
      activity: "idle",
    });
    expect(
      await host.conversation(child!, Date.parse("2026-08-04T00:00:00.000Z")),
    ).toEqual({
      displayAt: "2026-08-02T00:00:00.000Z",
      display: "exact",
      gateAt: "2026-08-02T00:00:00.000Z",
      gate: "exact",
      reason: null,
    });
    expect(read).toHaveBeenCalledWith({ direction: "tail", limit: 200 });
  } finally {
    host.dispose();
  }
});

it("keeps a projected child whose row is newer than its descriptor unknown", async () => {
  const read = vi.fn(async () => ({
    epoch: "epoch-1",
    gap: false,
    staleCursor: false,
    error: null,
    hasOlder: false,
    startCursor: null,
    window: { maxSeq: 2 },
    entries: [
      {
        timestamp: "2026-08-04T00:00:00.000Z",
        item: { type: "assistant_message" },
      },
    ],
  }));
  const compat = {
    subagents: vi.fn(async () => [
      {
        id: "child",
        title: "Worker",
        status: "completed",
        updatedAt: "2026-08-03T00:00:00.000Z",
      },
    ]),
    subagentTimeline: vi.fn(() => read),
  } as unknown as PaseoCompat;
  const host = providerHost(parentAgent, compat);
  try {
    const child = (await host.inventory()).agents.find(
      (agent) => agent.id === "parent/provider/child",
    );
    // The stamped row is neither activity nor a conversation time, and a child descriptor
    // never bounds the archive gate.
    expect(
      await host.conversation(child!, Date.parse("2026-08-05T00:00:00.000Z")),
    ).toEqual({
      displayAt: null,
      display: "unknown",
      gateAt: null,
      gate: "unknown",
      reason: "replay-timestamp",
    });
  } finally {
    host.dispose();
  }
});

it("keeps a parent readable when its provider children cannot be listed", async () => {
  const read = vi.fn(async () => ({
    epoch: "epoch-1",
    gap: false,
    staleCursor: false,
    error: null,
    hasOlder: false,
    startCursor: null,
    window: { maxSeq: 2 },
    entries: [
      {
        timestamp: "2026-08-02T00:00:00.000Z",
        item: { type: "assistant_message" },
      },
    ],
  }));
  const compat = {
    subagents: vi.fn(async () => {
      throw new Error("provider unavailable");
    }),
  } as unknown as PaseoCompat;
  const host = providerHost(parentAgent, compat, vi.fn(), [], read);
  try {
    const parent = (await host.inventory()).agents.find(
      (agent) => agent.id === "parent",
    );
    expect(parent?.childEnumeration).toBe("unavailable");
    expect(compat.subagents).toHaveBeenCalledTimes(1);
    await host.inventory();
    // A cached record keeps the daemon from being asked once per agent and pass.
    expect(compat.subagents).toHaveBeenCalledTimes(1);
    const evidence = await host.conversation(
      parent!,
      Date.parse("2026-08-04T00:00:00.000Z"),
    );
    expect(evidence.display).toBe("exact");
    expect(evidence.displayAt).toBe("2026-08-02T00:00:00.000Z");
  } finally {
    host.dispose();
  }
});

it("retries failed live child enumeration before allowing automatic archive", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-23T00:00:00.000Z"));
  const test = fixture({
    settings: settingsSchema.parse({ archiveDoneEnabled: true }),
  });
  test.inventory.workspaces.push(workspace("w1", "Done task", ["task:done"]));
  let attempts = 0;
  const subagents = vi.fn(async () => {
    if (++attempts < 3) throw new Error("temporary provider failure");
    return [];
  });
  const timeline: TimelineReader = async () => ({
    epoch: "epoch-1",
    gap: false,
    staleCursor: false,
    error: null,
    hasOlder: false,
    startCursor: null,
    window: { maxSeq: 1 },
    entries: [
      {
        timestamp: "2026-08-02T00:00:00.000Z",
        item: { type: "assistant_message" },
      },
    ],
  });
  const parent = {
    ...parentAgent,
    lastUserMessageAt: "2026-08-01T00:00:00.000Z",
  };
  const native = providerHost(
    parent,
    { subagents } as unknown as PaseoCompat,
    vi.fn(),
    [],
    timeline,
    () => test.inventory.workspaces,
  );
  const host = {
    ...test.host,
    inventory: native.inventory.bind(native),
    conversation: native.conversation.bind(native),
    recheckAgents: native.recheckAgents.bind(native),
    dispose: () => native.dispose(),
  };
  const board = new Workboard(host, test.store, test.now);
  try {
    await board.start();
    expect(subagents).toHaveBeenCalledTimes(1);
    expect(host.archive).not.toHaveBeenCalled();
    expect(board.snapshot().cards[0].lastConversationAt).toBe(
      "2026-08-02T00:00:00.000Z",
    );

    vi.setSystemTime(new Date("2026-09-23T00:00:59.999Z"));
    await board.refresh();
    expect(subagents).toHaveBeenCalledTimes(1);
    expect(host.archive).not.toHaveBeenCalled();

    vi.setSystemTime(new Date("2026-09-23T00:01:00.000Z"));
    await board.refresh();
    expect(subagents).toHaveBeenCalledTimes(2);
    expect(host.archive).not.toHaveBeenCalled();

    vi.setSystemTime(new Date("2026-09-23T00:01:59.999Z"));
    await board.refresh();
    expect(subagents).toHaveBeenCalledTimes(2);

    vi.setSystemTime(new Date("2026-09-23T00:02:00.000Z"));
    // A resting parent is listed only by the archive recheck: the third attempt.
    parent.status = "idle";
    await board.refresh();
    expect(subagents).toHaveBeenCalledTimes(3);
    expect(host.archive).toHaveBeenCalledExactlyOnceWith("w1");
    expect(board.snapshot().cards[0].archived?.status).toBe("archived");
  } finally {
    board.dispose();
    vi.useRealTimers();
  }
});

it.each(["empty", "exact"] as const)(
  "keeps a vanished child with an earlier %s read unknown across refresh and restart",
  async (firstRead) => {
    const old = "2026-08-02T00:00:00.000Z";
    const recent = "2026-09-22T00:00:00.000Z";
    const test = fixture({
      settings: settingsSchema.parse({ archiveDoneEnabled: true }),
    });
    test.inventory.workspaces.push(workspace("w1", "Task", ["task:todo"]));
    let children = [
      { id: "child", title: "Child", status: "completed", updatedAt: old },
    ];
    let childEntries =
      firstRead === "exact"
        ? [{ timestamp: old, item: { type: "assistant_message" } }]
        : [];
    const page = (entries: typeof childEntries) => ({
      epoch: "epoch-1",
      gap: false,
      staleCursor: false,
      error: null,
      hasOlder: false,
      startCursor: null,
      window: { maxSeq: entries.length },
      entries,
    });
    const compat = {
      subagents: vi.fn(async () => children),
      subagentTimeline: () => async () => page(childEntries),
    } as unknown as PaseoCompat;
    const parent = {
      ...parentAgent,
      lastUserMessageAt: "2026-08-01T00:00:00.000Z",
    };
    const timeline: TimelineReader = async () =>
      page([{ timestamp: old, item: { type: "assistant_message" } }]);
    const makeBoard = (store: Store) => {
      const observers: SubscriptionObserver<unknown>[] = [];
      const native = providerHost(
        parent,
        compat,
        vi.fn(),
        observers,
        timeline,
        () => test.inventory.workspaces,
      );
      const host = {
        ...test.host,
        inventory: native.inventory.bind(native),
        conversation: native.conversation.bind(native),
        dispose: () => native.dispose(),
      };
      return { board: new Workboard(host, store, test.now), observers };
    };
    const first = makeBoard(test.store);
    try {
      await first.board.start();
      expect(first.board.snapshot().cards[0].conversationAgents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "parent/provider/child" }),
        ]),
      );
      expect(test.host.archive).not.toHaveBeenCalled();

      childEntries = [
        { timestamp: recent, item: { type: "assistant_message" } },
      ];
      const emit = first.observers[2].update.bind(first.observers[2]);
      emit({
        type: "agent.provider_subagents.update",
        payload: {
          kind: "upsert",
          subagent: {
            parentAgentId: "parent",
            id: "child",
            updatedAt: recent,
          },
        },
      } as Parameters<typeof emit>[0]);
      children = [];
      emit({
        type: "agent.provider_subagents.update",
        payload: {
          kind: "remove",
          parentAgentId: "parent",
          subagentId: "child",
        },
      } as Parameters<typeof emit>[0]);
      test.inventory.workspaces[0].labels = ["task:done"];

      for (let i = 0; i < 2; i++) {
        await first.board.refresh();
        const card = first.board.snapshot().cards[0];
        expect(test.host.archive).not.toHaveBeenCalled();
        expect(card.lastConversationAt).toBe(old);
        expect(card.conversationGateEvidence).toBe("unknown");
        expect(card.dueAt).toBeNull();
      }
    } finally {
      first.board.dispose();
    }

    const resumed = makeBoard(new Store(test.backing));
    try {
      await resumed.board.start();
      const card = resumed.board.snapshot().cards[0];
      expect(test.host.archive).not.toHaveBeenCalled();
      expect(card.lastConversationAt).toBe(old);
      expect(card.conversationGateEvidence).toBe("unknown");
      expect(card.dueAt).toBeNull();
    } finally {
      resumed.board.dispose();
    }
  },
);

it("does not reuse a complete child list when the parent becomes archived without new activity", async () => {
  const parent = { ...parentAgent, archivedAt: null as string | null };
  const subagents = vi.fn(async () => [
    {
      id: "child",
      title: "Child",
      status: "completed",
      updatedAt: parent.updatedAt,
    },
  ]);
  const observers: SubscriptionObserver<unknown>[] = [];
  const host = providerHost(
    parent,
    { subagents } as unknown as PaseoCompat,
    vi.fn(),
    observers,
  );
  try {
    expect((await host.inventory()).agents[0].childEnumeration).toBe(
      "complete",
    );
    parent.archivedAt = "2026-09-23T00:00:00.000Z";
    expect((await host.inventory()).agents[0].childEnumeration).toBe("refused");
    invalidateChildListing(observers, "snapshot");
    const restored = await host.inventory();
    expect(restored.agents[0].childEnumeration).toBe("refused");
    expect(restored.agents.map((agent) => agent.id)).toContain(
      "parent/provider/child",
    );
    expect(subagents).toHaveBeenCalledTimes(1);
  } finally {
    host.dispose();
  }
});

it("keeps an archived parent off the periodic timeline path", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-23T00:00:00.000Z"));
  const read = vi.fn(async () => ({
    epoch: "epoch-1",
    gap: false,
    staleCursor: false,
    error: null,
    hasOlder: false,
    startCursor: null,
    window: { maxSeq: 2 },
    entries: [
      {
        timestamp: "2026-08-02T00:00:00.000Z",
        item: { type: "assistant_message" },
      },
    ],
  }));
  const compat = { subagents: vi.fn() } as unknown as PaseoCompat;
  const host = providerHost(
    {
      ...parentAgent,
      archivedAt: "2026-08-03T01:00:00.000Z",
      lastUserMessageAt: "2026-08-01T00:00:00.000Z",
    },
    compat,
    vi.fn(),
    [],
    read,
  );
  try {
    const parent = (await host.inventory()).agents.find(
      (agent) => agent.id === "parent",
    );
    expect(parent?.childEnumeration).toBe("refused");
    expect(compat.subagents).not.toHaveBeenCalled();
    vi.setSystemTime(new Date("2026-09-23T00:02:00.000Z"));
    expect(
      (await host.inventory()).agents.find((agent) => agent.id === "parent")
        ?.childEnumeration,
    ).toBe("refused");
    expect(compat.subagents).not.toHaveBeenCalled();
    const periodic = await host.conversation(
      parent!,
      Date.parse("2026-08-04T00:00:00.000Z"),
    );
    // Re-projecting an archived history costs seconds per read, so the periodic refresh
    // stays on the recorded bounds and only the archive recheck asks for the timeline.
    expect(read).not.toHaveBeenCalled();
    expect(periodic).toEqual({
      displayAt: "2026-08-01T00:00:00.000Z",
      display: "lower-bound",
      gateAt: "2026-08-03T00:00:00.000Z",
      gate: "upper-bound",
      reason: null,
    });
    const candidate = await host.conversation(
      parent!,
      Date.parse("2026-08-04T00:00:00.000Z"),
      { recheck: true },
    );
    expect(read).toHaveBeenCalled();
    expect(candidate.display).toBe("exact");
    expect(candidate.gate).toBe("exact");
  } finally {
    host.dispose();
    vi.useRealTimers();
  }
});

it("never labels a lower bound exact when the recorded user message is missing", async () => {
  const read = vi.fn(async () => ({
    epoch: "epoch-1",
    gap: false,
    staleCursor: false,
    error: null,
    hasOlder: false,
    startCursor: null,
    window: { maxSeq: 2 },
    entries: [
      {
        timestamp: "2026-08-01T00:00:00.000Z",
        item: { type: "assistant_message" },
      },
    ],
  }));
  const compat = { subagents: vi.fn(async () => []) } as unknown as PaseoCompat;
  const host = providerHost(
    { ...parentAgent, lastUserMessageAt: "2026-08-02T00:00:00.000Z" },
    compat,
    vi.fn(),
    [],
    read,
  );
  try {
    const parent = (await host.inventory()).agents.find(
      (agent) => agent.id === "parent",
    );
    const evidence = await host.conversation(
      parent!,
      Date.parse("2026-08-04T00:00:00.000Z"),
    );
    // The record says a user message exists that this timeline does not show.
    expect(evidence).toEqual({
      displayAt: "2026-08-02T00:00:00.000Z",
      display: "lower-bound",
      gateAt: "2026-08-03T00:00:00.000Z",
      gate: "upper-bound",
      reason: "timeline-unreadable",
    });
  } finally {
    host.dispose();
  }
});

it("reports Agent create-delete between inventories, provider events and subscription loss separately from workspace edits", async () => {
  const changed = vi.fn();
  const observers: SubscriptionObserver<unknown>[] = [];
  const host = providerHost(
    [],
    { subagents: async () => [] } as unknown as PaseoCompat,
    changed,
    observers,
  );
  try {
    await host.inventory();
    const update = (index: number, message: unknown) =>
      observers[index].update(
        message as Parameters<SubscriptionObserver<unknown>["update"]>[0],
      );
    update(0, {
      type: "workspace_update",
      payload: {
        kind: "upsert",
        workspace: workspace("w1", "Edited", ["task:done"]),
      },
    });
    expect(changed).toHaveBeenLastCalledWith("w1");
    update(1, {
      type: "agent_update",
      payload: { kind: "upsert", agent: parentAgent },
    });
    expect(changed).toHaveBeenLastCalledWith("w1", true);
    update(2, {
      type: "agent.provider_subagents.update",
      payload: { kind: "remove", parentAgentId: "parent", subagentId: "child" },
    });
    expect(changed).toHaveBeenLastCalledWith("w1", true);
    update(1, {
      type: "agent_update",
      payload: { kind: "remove", agentId: "parent" },
    });
    expect(changed).toHaveBeenLastCalledWith("w1", true);
    expect((await host.inventory()).agents).toEqual([]);
    for (const observer of observers) {
      observer.snapshot({});
      expect(changed).toHaveBeenLastCalledWith(undefined, true);
      observer.error!(new Error("Lost subscription"));
      expect(changed).toHaveBeenLastCalledWith(undefined, true);
    }
  } finally {
    host.dispose();
  }
});

it.each(["create-delete", "provider", "snapshot", "subscription failure"])(
  "resets Workboard's empty bound through the Host callback after %s between polls",
  async (event) => {
    const test = fixture({
      settings: settingsSchema.parse({
        archiveCanceledEnabled: true,
        archiveCanceledAfterDays: 1,
      }),
    });
    test.inventory.workspaces.push(
      workspace("w1", undefined, ["task:canceled"]),
    );
    const observers: SubscriptionObserver<unknown>[] = [];
    let clock = test.now();
    let board: Workboard;
    const native = providerHost(
      [],
      { subagents: async () => [] } as unknown as PaseoCompat,
      (id?: string, agentsChanged?: boolean) =>
        agentsChanged ? board.agentsChanged(id) : board.changed(id),
      observers,
      undefined,
      () => test.inventory.workspaces,
    );
    const host = { ...test.host, inventory: () => native.inventory() };
    board = new Workboard(host, test.store, () => clock);
    try {
      await board.start();
      clock += 24 * 60 * 60 * 1000 + 1;
      const update = (index: number, message: unknown) =>
        observers[index].update(
          message as Parameters<SubscriptionObserver<unknown>["update"]>[0],
        );
      if (event === "create-delete") {
        update(1, {
          type: "agent_update",
          payload: { kind: "upsert", agent: parentAgent },
        });
        update(1, {
          type: "agent_update",
          payload: { kind: "remove", agentId: "parent" },
        });
      } else if (event === "provider")
        invalidateChildListing(observers, "upsert");
      else if (event === "snapshot") observers[0].snapshot({});
      else observers[1].error!(new Error("Subscription lost"));
      await board.refresh();
      expect(test.host.archive).not.toHaveBeenCalled();
      expect(board.snapshot().cards[0].conversationGateAt).toBe(
        new Date(clock).toISOString(),
      );
      clock += 24 * 60 * 60 * 1000 + 1;
      await board.refresh();
      expect(test.host.archive).toHaveBeenCalledExactlyOnceWith("w1");
    } finally {
      board.dispose();
      native.dispose();
    }
  },
);

it("invalidates both workspaces when an Agent moves and scopes its removal to the destination", async () => {
  const test = fixture({
    settings: settingsSchema.parse({
      archiveCanceledEnabled: true,
      archiveCanceledAfterDays: 1,
    }),
  });
  test.inventory.workspaces.push(
    workspace("w1", undefined, ["task:canceled"]),
    workspace("w2", undefined, ["task:canceled"]),
    workspace("other", undefined, ["task:canceled"]),
  );
  const observers: SubscriptionObserver<unknown>[] = [];
  let clock = test.now();
  let board: Workboard;
  const nativeAgents: Record<string, unknown>[] = [];
  const native = providerHost(
    nativeAgents,
    { subagents: async () => [] } as unknown as PaseoCompat,
    (id, agentsChanged) =>
      agentsChanged ? board.agentsChanged(id) : board.changed(id),
    observers,
    undefined,
    () => test.inventory.workspaces,
  );
  board = new Workboard(
    { ...test.host, inventory: () => native.inventory() },
    test.store,
    () => clock,
  );
  const update = (payload: unknown) =>
    observers[1].update({ type: "agent_update", payload } as Parameters<
      SubscriptionObserver<unknown>["update"]
    >[0]);
  const bound = (id: string) =>
    board.snapshot().cards.find((card) => card.workspaceId === id)!
      .conversationGateAt;
  try {
    await board.start();
    clock += 1000;
    nativeAgents.push(parentAgent);
    update({ kind: "upsert", agent: parentAgent });
    await vi.waitFor(() =>
      expect(
        board.snapshot().cards.find((card) => card.workspaceId === "w1")
          ?.agents,
      ).toHaveLength(1),
    );
    clock += 1000;
    nativeAgents[0] = { ...parentAgent, workspaceId: "w2" };
    update({ kind: "upsert", agent: nativeAgents[0] });
    const departedAt = new Date(clock).toISOString();
    await vi.waitFor(() => {
      expect(bound("w1")).toBe(departedAt);
      expect(bound("w2")).not.toBe(new Date(test.now()).toISOString());
    });
    clock += 1000;
    nativeAgents.length = 0;
    update({ kind: "remove", agentId: parentAgent.id });
    await vi.waitFor(() =>
      expect(bound("w2")).toBe(new Date(clock).toISOString()),
    );
    expect(bound("w1")).toBe(departedAt);
    expect(bound("w2")).toBe(new Date(clock).toISOString());
    expect(bound("other")).toBe(new Date(test.now()).toISOString());
    clock = Date.parse(departedAt) + 86400001;
    await board.refresh();
    expect(vi.mocked(test.host.archive).mock.calls.map(([id]) => id)).toEqual(
      expect.arrayContaining(["w1", "other"]),
    );
    expect(test.host.archive).not.toHaveBeenCalledWith("w2");
    clock += 1000;
    await board.refresh();
    expect(test.host.archive).toHaveBeenCalledWith("w2");
  } finally {
    board.dispose();
    native.dispose();
  }
});

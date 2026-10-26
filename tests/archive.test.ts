import { afterEach, expect, it, vi } from "vitest";
import { settingsSchema } from "../shared/model";
import { Workboard } from "../server/workboard";
import { Store } from "../server/store";
import { migrateData } from "../shared/migrations";
import { agentEvidence, fixture, observed, workspace } from "./fixtures";
import { newTask } from "../shared/model";
afterEach(() => vi.useRealTimers());
function dueFixture() {
  const test = fixture({
    settings: settingsSchema.parse({
      archiveDoneEnabled: true,
      archiveCanceledEnabled: true,
    }),
  });
  test.inventory.workspaces.push(workspace("old", undefined, ["task:done"]));
  test.inventory.agents.push({
    id: "a",
    workspaceId: "old",
    title: null,
    updatedAt: "2026-08-01T00:00:00Z",
    lastUserMessageAt: "2026-08-01T00:00:00Z",
    activity: "idle",
  });
  test.host.conversation = agentEvidence("2026-08-01T00:00:00Z");
  return test;
}
it("archives on cold start without any UI and keeps the original conversation clock", async () => {
  const { board, host } = dueFixture();
  try {
    await board.start();
    expect(host.archive).toHaveBeenCalledExactlyOnceWith("old");
    expect(board.snapshot().cards[0].archived).toMatchObject({
      status: "archived",
      kind: "automatic",
      lastConversationAt: "2026-08-01T00:00:00.000Z",
    });
    await board.refresh();
    expect(host.archive).toHaveBeenCalledTimes(1);
  } finally {
    board.dispose();
  }
});
it("periodic work strictly crosses 30 days, includes archived Agents, and stops after dispose", async () => {
  vi.useFakeTimers();
  const test = dueFixture();
  let clock = Date.parse("2026-08-31T00:00:00Z");
  test.inventory.agents[0].archivedAt = "2026-08-02T00:00:00Z";
  const board = new Workboard(test.host, test.store, () => clock, 1000);
  try {
    await board.start();
    expect(test.host.archive).not.toHaveBeenCalled();
    clock += 1;
    await vi.advanceTimersByTimeAsync(1000);
    expect(test.host.archive).toHaveBeenCalledExactlyOnceWith("old");
    board.dispose();
    await vi.advanceTimersByTimeAsync(5000);
    expect(test.host.archive).toHaveBeenCalledTimes(1);
  } finally {
    board.dispose();
  }
});
it("does not archive a recently emptied workspace using an old task edit", async () => {
  const test = fixture({
    settings: settingsSchema.parse({ archiveCanceledEnabled: true }),
  });
  test.inventory.workspaces.push(
    workspace("empty", undefined, ["task:canceled"]),
  );
  try {
    await test.board.start();
    await test.store.update((data) => {
      data.tasks[0].updatedAt = "2026-08-01T00:00:00Z";
    });
    await test.board.refresh();
    expect(test.host.archive).not.toHaveBeenCalled();
    expect(test.board.snapshot().cards[0]).toMatchObject({
      conversationGateAt: "2026-09-23T00:00:00.000Z",
      conversationGateEvidence: "upper-bound",
    });
  } finally {
    test.board.dispose();
  }
});

const day = 24 * 60 * 60 * 1000;
function emptyFixture() {
  const test = fixture({
    settings: settingsSchema.parse({
      archiveCanceledEnabled: true,
      archiveCanceledAfterDays: 1,
    }),
  });
  test.inventory.workspaces.push(
    workspace("empty", undefined, ["task:canceled"]),
  );
  let clock = test.now();
  const board = new Workboard(test.host, test.store, () => clock);
  return {
    ...test,
    board,
    advance: (ms: number) => {
      clock += ms;
    },
    clock: () => clock,
  };
}
it("keeps the first empty bound through edits and labels, then archives strictly after the delay", async () => {
  const test = emptyFixture();
  try {
    await test.board.start();
    const bound = test.board.snapshot().cards[0].conversationGateAt;
    test.advance(day);
    test.inventory.workspaces[0].labels.push("unrelated");
    test.board.changed("empty");
    await test.store.update((data) => {
      data.tasks[0].updatedAt = new Date(test.clock()).toISOString();
      data.tasks[0].description = "Edited";
    });
    await test.board.refresh();
    expect(test.board.snapshot().cards[0].conversationGateAt).toBe(bound);
    expect(test.host.archive).not.toHaveBeenCalled();
    test.advance(1);
    await test.board.refresh();
    expect(test.host.archive).toHaveBeenCalledExactlyOnceWith("empty");
  } finally {
    test.board.dispose();
  }
});
it.each([
  "agent event",
  "disconnect",
  "inventory failure",
  "nonzero inventory",
  "restart",
])("restarts the empty clock after %s", async (change) => {
  const test = emptyFixture();
  let board = test.board;
  try {
    await board.start();
    test.advance(day + 1);
    if (change === "agent event") board.agentsChanged("empty");
    if (change === "disconnect") board.disconnected();
    if (change === "inventory failure") {
      const inventory = test.host.inventory;
      test.host.inventory = async () => {
        throw new Error("inventory failed");
      };
      await expect(board.refresh()).rejects.toThrow("inventory failed");
      test.host.inventory = inventory;
    }
    if (change === "nonzero inventory") {
      test.inventory.agents.push({
        id: "a",
        workspaceId: "empty",
        title: null,
        activity: "idle",
        updatedAt: new Date(test.clock()).toISOString(),
        lastUserMessageAt: null,
      });
      await board.refresh();
      test.inventory.agents.length = 0;
    }
    if (change === "restart") {
      board.dispose();
      board = new Workboard(test.host, test.store, test.clock);
      await board.start();
    } else await board.refresh();
    expect(test.host.archive).not.toHaveBeenCalled();
    expect(board.snapshot().cards[0].conversationGateAt).toBe(
      new Date(test.clock()).toISOString(),
    );
    test.advance(day + 1);
    await board.refresh();
    expect(test.host.archive).toHaveBeenCalledExactlyOnceWith("empty");
  } finally {
    board.dispose();
  }
});
it.each([
  "reconcile",
  "verify",
  "safety",
  "final inventory",
  "final inventory failure",
])("rejects empty evidence invalidated during %s", async (phase) => {
  const test = emptyFixture();
  try {
    await test.board.start();
    test.advance(day + 1);
    const invalidate = () => test.board.agentsChanged("empty");
    if (phase === "verify")
      test.host.recheckAgents = vi.fn(async (agents) => {
        invalidate();
        return [...agents];
      });
    if (phase === "safety")
      test.host.safety = async () => {
        invalidate();
        return null;
      };
    const inventory = test.host.inventory;
    let reads = 0;
    test.host.inventory = async () => {
      const result = await inventory();
      reads++;
      if (phase === "final inventory failure" && reads === 3)
        throw new Error("Inventory lost");
      if (
        (phase === "reconcile" && reads === 1) ||
        (phase === "final inventory" && reads === 3)
      )
        invalidate();
      return result;
    };
    await test.board.refresh();
    expect(test.host.archive).not.toHaveBeenCalled();
    test.host.inventory = inventory;
    test.host.safety = async () => null;
    test.host.recheckAgents = vi.fn(async (agents) => [...agents]);
    await test.board.refresh();
    expect(test.host.archive).not.toHaveBeenCalled();
    expect(test.board.snapshot().cards[0].conversationGateAt).toBe(
      new Date(test.clock()).toISOString(),
    );
  } finally {
    test.board.dispose();
  }
});
it.each(["recorded child", "unresolved enumeration"])(
  "retains %s after the last Agent is deleted",
  async (risk) => {
    const test = emptyFixture();
    try {
      await test.board.start();
      await test.store.update((data) => {
        if (risk === "recorded child")
          data.tasks[0].conversationAgents = [
            {
              id: "parent/provider/child",
              lastObservedAt: "2026-08-01T00:00:00Z",
              seenWhileLive: true,
            },
          ];
        else data.tasks[0].conversationReason = "child-enumeration-unavailable";
      });
      test.advance(100 * day);
      await test.board.refresh();
      expect(test.host.archive).not.toHaveBeenCalled();
      expect(test.board.snapshot().cards[0].conversationGateEvidence).toBe(
        "unknown",
      );
    } finally {
      test.board.dispose();
    }
  },
);

it("retains unresolved child enumeration when a higher priority timeline error masks its reason", async () => {
  const test = emptyFixture();
  const parent = {
    id: "parent",
    workspaceId: "empty",
    title: null,
    activity: "idle" as const,
    updatedAt: "2026-09-22T23:00:00Z",
    lastUserMessageAt: null,
    childEnumeration: "unavailable" as const,
  };
  test.inventory.agents.push(parent);
  test.host.conversation = async () => {
    throw new Error("Timeline unreadable");
  };
  let board = test.board;
  try {
    await board.start();
    expect(board.snapshot().cards[0]).toMatchObject({
      conversationGateEvidence: "unknown",
      conversationReason: "timeline-unreadable",
      conversationAgents: [],
    });
    test.inventory.agents.length = 0;
    await board.refresh();
    expect(board.snapshot().cards[0].conversationGateEvidence).toBe("unknown");
    await board.refresh();
    expect(board.snapshot().cards[0].conversationGateEvidence).toBe("unknown");
    board.dispose();
    board = new Workboard(test.host, new Store(test.backing), test.clock);
    await board.start();
    test.advance(100 * day);
    await board.refresh();
    expect(board.snapshot().cards[0].conversationGateEvidence).toBe("unknown");
    expect(test.host.archive).not.toHaveBeenCalled();
  } finally {
    board.dispose();
  }
});

it("starts an empty waiting period after a bounded timeline failure with complete child enumeration", async () => {
  const test = emptyFixture();
  test.inventory.agents.push({
    id: "parent",
    workspaceId: "empty",
    title: null,
    activity: "idle",
    updatedAt: "2026-09-22T23:00:00Z",
    lastUserMessageAt: null,
    childEnumeration: "complete",
  });
  test.host.conversation = async () => {
    throw new Error("Timeline unreadable");
  };
  try {
    await test.board.start();
    expect(test.board.snapshot().cards[0]).toMatchObject({
      conversationGateEvidence: "upper-bound",
      conversationReason: "timeline-unreadable",
    });
    test.inventory.agents.length = 0;
    await test.board.refresh();
    expect(test.board.snapshot().cards[0]).toMatchObject({
      conversationGateAt: new Date(test.clock()).toISOString(),
      conversationGateEvidence: "upper-bound",
      conversationReason: null,
    });
    expect(test.host.archive).not.toHaveBeenCalled();
    test.advance(day + 1);
    await test.board.refresh();
    expect(test.host.archive).toHaveBeenCalledExactlyOnceWith("empty");
  } finally {
    test.board.dispose();
  }
});

it("defers no conversation, recent replies, busy agents, unsafe Git and label conflicts", async () => {
  for (const reason of ["none", "recent", "busy", "git", "conflict"]) {
    const { board, host, inventory } = dueFixture();
    if (reason === "none") host.conversation = agentEvidence(null);
    if (reason === "recent")
      host.conversation = agentEvidence("2026-09-22T00:00:00Z");
    if (reason === "busy") inventory.agents[0].activity = "waiting";
    if (reason === "git") host.safety = async () => "git-dirty";
    if (reason === "conflict")
      inventory.workspaces[0].labels.push("task:review");
    try {
      await board.start();
      expect(host.archive, reason).not.toHaveBeenCalled();
      expect(board.snapshot().cards[0].archived, reason).toBeNull();
    } finally {
      board.dispose();
    }
  }
});
it("archives an unreadable history from its recorded upper bound and keeps the reason", async () => {
  const { board, host } = dueFixture();
  host.conversation = async () => {
    throw new Error("History missing");
  };
  try {
    await board.start();
    // Paseo's recorded activity is never earlier than the last message, so gating on it can
    // only delay an archive; the degraded evidence stays visible on the card.
    expect(host.archive).toHaveBeenCalledExactlyOnceWith("old");
    expect(board.snapshot().cards[0]).toMatchObject({
      conversationDisplayEvidence: "upper-bound",
      conversationGateEvidence: "upper-bound",
      conversationReason: "timeline-unreadable",
    });
  } finally {
    board.dispose();
  }
});
it("invalidates a scan when labels or a new conversation change while safety checks wait", async () => {
  for (const change of ["labels", "conversation"]) {
    const { board, host, inventory } = dueFixture();
    host.safety = vi.fn(async () => {
      if (change === "labels") inventory.workspaces[0].labels = ["task:todo"];
      else host.conversation = agentEvidence("2026-09-23T00:00:00Z");
      board.changed();
      return null;
    });
    try {
      await board.start();
      expect(host.safety).toHaveBeenCalled();
      expect(host.archive).not.toHaveBeenCalled();
      expect(board.snapshot().cards[0].archived).toBeNull();
    } finally {
      board.dispose();
    }
  }
});
it("does not let activity in a different workspace indefinitely block an old task", async () => {
  const { board, host } = dueFixture();
  host.safety = async () => {
    board.changed("some-other-workspace");
    return null;
  };
  try {
    await board.start();
    expect(host.archive).toHaveBeenCalledExactlyOnceWith("old");
  } finally {
    board.dispose();
  }
});

it("defers unrelated archive candidates during scoped events but checks them on the next full refresh", async () => {
  vi.useFakeTimers();
  const { board, host, inventory } = dueFixture();
  inventory.workspaces[0].labels = ["task:todo"];
  inventory.workspaces.push(workspace("active"));
  await board.start();
  try {
    inventory.workspaces[0].labels = ["task:done"];
    board.changed("active");
    await vi.advanceTimersByTimeAsync(300);
    expect(host.archive).not.toHaveBeenCalled();
    await board.refresh();
    expect(host.archive).toHaveBeenCalledExactlyOnceWith("old");
  } finally {
    board.dispose();
  }
});

it.each(["disconnect", "stage change"])(
  "does not archive when a %s arrives while reconciliation is waiting",
  async (change) => {
    const { board, host, inventory } = dueFixture();
    inventory.workspaces[0].labels = ["task:todo"];
    await board.start();
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reading = new Promise<void>((resolve) => {
      entered = resolve;
    });
    host.conversation = async () => {
      entered();
      await blocked;
      return observed("2026-08-01T00:00:00Z");
    };
    inventory.workspaces[0].labels = ["task:done"];
    try {
      const refresh = board.refresh().catch(() => undefined);
      await reading;
      const mutation =
        change === "stage change"
          ? board.mutate({
              action: "stage",
              taskId: board.snapshot().cards[0].id,
              stage: "todo",
              expectedLabels: ["task:done"],
            })
          : null;
      if (change === "disconnect")
        board.disconnected("Fixture connection lost");
      release();
      await refresh;
      if (mutation) expect((await mutation).cards[0].stage).toBe("todo");
      else
        expect(board.snapshot()).toMatchObject({
          connected: false,
          error: "Fixture connection lost",
        });
      expect(host.archive).not.toHaveBeenCalled();
    } finally {
      release();
      board.dispose();
    }
  },
);
it("uses the latest of multiple agents, including a provider child, without borrowing another workspace's time", async () => {
  const test = dueFixture();
  test.inventory.agents.push({
    id: "a/provider/child",
    parentAgentId: "a",
    subagentId: "child",
    workspaceId: "old",
    title: "Child",
    updatedAt: "2026-09-22T00:00:00Z",
    lastUserMessageAt: null,
    activity: "idle",
  });
  test.inventory.workspaces.push(workspace("other"));
  test.inventory.agents.push({
    id: "unrelated",
    workspaceId: "other",
    title: null,
    updatedAt: "2026-09-23T00:00:00Z",
    lastUserMessageAt: null,
    activity: "idle",
  });
  test.host.conversation = async (agent) =>
    observed(
      agent.id.includes("child")
        ? "2026-09-22T00:00:00Z"
        : agent.id === "unrelated"
          ? "2026-09-23T00:00:00Z"
          : "2026-08-01T00:00:00Z",
    );
  try {
    await test.board.start();
    expect(test.host.archive).not.toHaveBeenCalled();
    expect(
      test.board.snapshot().cards.find((c) => c.workspaceId === "old")
        ?.lastConversationAt,
    ).toBe("2026-09-22T00:00:00.000Z");
  } finally {
    test.board.dispose();
  }
});

it.each([
  {
    name: "replayed history",
    child: observed(null, { display: "unknown", reason: "replay-timestamp" }),
    displayAt: "2026-08-01T00:00:00.000Z",
  },
  {
    name: "accepted rows mixed with replayed history",
    child: observed("2026-08-02T00:00:00Z", {
      display: "lower-bound",
      gateAt: null,
      gate: "unknown",
      reason: "replay-timestamp",
    }),
    displayAt: "2026-08-02T00:00:00.000Z",
  },
  {
    name: "a partial history",
    child: observed("2026-08-02T00:00:00Z", {
      display: "lower-bound",
      gateAt: null,
      gate: "unknown",
      reason: "child-timeline-unreadable",
    }),
    displayAt: "2026-08-02T00:00:00.000Z",
  },
])(
  "keeps $name unsafe while a child is present, after removal and after restart",
  async ({ child, displayAt }) => {
    const test = dueFixture();
    test.inventory.agents[0].childEnumeration = "complete";
    test.inventory.agents.push({
      id: "a/provider/child",
      parentAgentId: "a",
      subagentId: "child",
      workspaceId: "old",
      title: "Child",
      updatedAt: "2026-09-22T00:00:00Z",
      lastUserMessageAt: null,
      activity: "idle",
    });
    test.host.conversation = async (agent) =>
      agent.id === "a" ? observed("2026-08-01T00:00:00Z") : child;
    const resumed = new Workboard(test.host, new Store(test.backing), test.now);
    const expectBlocked = (board: Workboard) => {
      expect(board.snapshot().cards[0]).toMatchObject({
        archived: null,
        lastConversationAt: displayAt,
        conversationGateAt: null,
        conversationGateEvidence: "unknown",
        dueAt: null,
      });
      expect(test.host.archive).not.toHaveBeenCalled();
    };
    try {
      await test.board.start();
      expectBlocked(test.board);
      test.inventory.agents.pop();
      await test.board.refresh();
      expectBlocked(test.board);
      await test.board.refresh();
      expectBlocked(test.board);
      test.board.dispose();
      await resumed.start();
      await resumed.refresh();
      expectBlocked(resumed);
    } finally {
      test.board.dispose();
      resumed.dispose();
    }
  },
);

it("keeps an enumerated child with a verified empty timeline archiveable", async () => {
  const test = dueFixture();
  test.inventory.agents[0].childEnumeration = "complete";
  test.inventory.agents.push({
    id: "a/provider/child",
    parentAgentId: "a",
    subagentId: "child",
    workspaceId: "old",
    title: "Child",
    updatedAt: "2026-09-22T00:00:00Z",
    lastUserMessageAt: null,
    activity: "idle",
  });
  test.host.conversation = async (agent) =>
    observed(agent.id === "a" ? "2026-08-01T00:00:00Z" : null);
  try {
    await test.board.start();
    expect(test.host.archive).toHaveBeenCalledExactlyOnceWith("old");
  } finally {
    test.board.dispose();
  }
});

it.each([
  { name: "exact", evidence: observed("2026-08-02T00:00:00Z") },
  {
    name: "upper bound",
    evidence: observed("2026-08-02T00:00:00Z", {
      display: "lower-bound",
      gate: "upper-bound",
      gateAt: "2026-09-10T00:00:00Z",
      reason: "truncated-window",
    }),
  },
  { name: "empty", evidence: observed(null) },
])(
  "keeps a child unknown after its $name read, a newer message and removal, including restart",
  async ({ evidence }) => {
    const test = dueFixture();
    test.inventory.workspaces[0].labels = ["task:todo"];
    test.inventory.agents[0].childEnumeration = "complete";
    test.inventory.agents.push({
      ...test.inventory.agents[0],
      id: "a/provider/child",
      parentAgentId: "a",
      subagentId: "child",
      lastUserMessageAt: null,
      childEnumeration: undefined,
    });
    let childEvidence = evidence;
    test.host.conversation = async (agent) =>
      agent.id === "a" ? observed("2026-08-01T00:00:00Z") : childEvidence;
    let now = test.now();
    const resumed = new Workboard(
      test.host,
      new Store(test.backing),
      () => now,
    );
    const bound = new Date(
      evidence.gateAt ?? "2026-08-01T00:00:00Z",
    ).toISOString();
    const expectBlocked = (board: Workboard) => {
      expect(board.snapshot().cards[0]).toMatchObject({
        conversationGateEvidence: "unknown",
        conversationGateAt: null,
        lastConversationAt: new Date(
          evidence.displayAt ?? "2026-08-01T00:00:00Z",
        ).toISOString(),
        dueAt: null,
        archived: null,
      });
      expect(test.host.archive).not.toHaveBeenCalled();
    };
    try {
      await test.board.start();
      expect(test.board.snapshot().cards[0].conversationGateAt).toBe(bound);
      childEvidence = observed("2026-09-22T00:00:00Z");
      test.inventory.workspaces[0].labels = ["task:done"];
      test.inventory.agents.pop();
      await test.board.refresh();
      expectBlocked(test.board);
      await test.board.refresh();
      expectBlocked(test.board);
      test.board.dispose();
      await resumed.start();
      expectBlocked(resumed);
      now += 365 * 24 * 60 * 60 * 1000;
      await resumed.refresh();
      expectBlocked(resumed);
    } finally {
      test.board.dispose();
      resumed.dispose();
    }
  },
);

it("does not move the archive gate back to an old task timestamp when its last agent disappears", async () => {
  const test = fixture({
    settings: settingsSchema.parse({ archiveDoneEnabled: true }),
    tasks: [
      {
        ...newTask("task", "Old task", "2026-08-01T00:00:00Z", "done"),
        workspaceId: "old",
        lastStage: "done",
      },
    ],
  });
  test.inventory.workspaces.push(workspace("old", undefined, ["task:done"]));
  test.inventory.agents.push({
    id: "a",
    workspaceId: "old",
    title: null,
    updatedAt: "2026-09-22T00:00:00Z",
    lastUserMessageAt: "2026-09-22T00:00:00Z",
    activity: "idle",
  });
  test.host.conversation = agentEvidence("2026-09-22T00:00:00Z");
  try {
    await test.board.start();
    expect(test.board.snapshot().cards[0].conversationGateAt).toBe(
      "2026-09-22T00:00:00.000Z",
    );
    test.inventory.agents.length = 0;
    await test.board.refresh();
    expect(test.host.archive).not.toHaveBeenCalled();
    expect(test.board.snapshot().cards[0]).toMatchObject({
      conversationGateAt: "2026-09-23T00:00:00.000Z",
      conversationGateEvidence: "upper-bound",
    });
  } finally {
    test.board.dispose();
  }
});
it("keeps native timeout/partial failure uncertain across restart and never sends a second archive", async () => {
  for (const failure of ["timeout", "partial"]) {
    const { board, host, backing, now } = dueFixture();
    host.archive = vi.fn(async () => {
      if (failure === "timeout") throw new Error("Timeout");
      return { archivedAt: null, error: "Worktree cleanup failed" };
    });
    try {
      await board.start();
      expect(board.snapshot().cards[0].archived?.status).toBe("uncertain");
      board.dispose();
      const resumed = new Workboard(host, new Store(backing), now);
      await resumed.start();
      await resumed.refresh();
      expect(host.archive).toHaveBeenCalledTimes(1);
      expect(resumed.snapshot().cards[0].archived?.status).toBe("uncertain");
      resumed.dispose();
    } finally {
      board.dispose();
    }
  }
});

function vanishedChildFixture(lastObservedAt: string | null) {
  const test = fixture({
    settings: settingsSchema.parse({
      archiveDoneEnabled: true,
      archiveCanceledEnabled: true,
    }),
    tasks: [
      {
        ...newTask("task", "Old task", "2026-08-01T00:00:00Z", "done"),
        workspaceId: "old",
        lastStage: "done",
        conversationAgents: [
          {
            id: "a/provider/child",
            lastObservedAt,
            seenWhileLive: true,
          },
        ],
      },
    ],
  });
  test.inventory.workspaces.push(workspace("old", undefined, ["task:done"]));
  test.inventory.agents.push({
    id: "a",
    workspaceId: "old",
    title: null,
    updatedAt: "2026-08-01T00:00:00Z",
    lastUserMessageAt: "2026-08-01T00:00:00Z",
    activity: "idle",
  });
  test.host.conversation = agentEvidence("2026-08-01T00:00:00Z");
  return test;
}

it.each(["2026-08-02T00:00:00Z", null])(
  "keeps legacy child records unknown across loading and restart, recorded time: %s",
  async (lastObservedAt) => {
    const test = vanishedChildFixture(lastObservedAt);
    for (let restart = 0; restart < 2; restart++) {
      const board = new Workboard(test.host, new Store(test.backing), test.now);
      try {
        await board.start();
        await board.refresh();
        expect(board.snapshot().cards[0]).toMatchObject({
          lastConversationAt: new Date(
            lastObservedAt ?? "2026-08-01T00:00:00Z",
          ).toISOString(),
          conversationDisplayEvidence: "lower-bound",
          conversationGateAt: null,
          conversationGateEvidence: "unknown",
          conversationReason: "child-enumeration-unavailable",
          dueAt: null,
          archived: null,
        });
        expect(test.host.archive).not.toHaveBeenCalled();
      } finally {
        board.dispose();
      }
    }
  },
);

it.each(["unavailable", "refused"] as const)(
  "defers an idle parent's archive while child enumeration is %s, including after restart",
  async (childEnumeration) => {
    const test = dueFixture();
    test.inventory.agents[0].childEnumeration = childEnumeration;
    const resumed = new Workboard(test.host, new Store(test.backing), test.now);
    try {
      await test.board.start();
      expect(test.board.snapshot().cards[0]).toMatchObject({
        archived: null,
        lastConversationAt: "2026-08-01T00:00:00.000Z",
        conversationGateAt: null,
        conversationGateEvidence: "unknown",
        conversationReason: "child-enumeration-unavailable",
      });
      expect(test.host.archive).not.toHaveBeenCalled();
      await test.board.refresh();
      expect(test.board.snapshot().cards[0].conversationGateEvidence).toBe(
        "unknown",
      );
      test.board.dispose();
      await resumed.start();
      expect(resumed.snapshot().cards[0].conversationGateEvidence).toBe(
        "unknown",
      );
      expect(test.host.archive).not.toHaveBeenCalled();
      test.inventory.agents[0].childEnumeration = "complete";
      await resumed.refresh();
      expect(test.host.archive).toHaveBeenCalledExactlyOnceWith("old");
    } finally {
      test.board.dispose();
      resumed.dispose();
    }
  },
);

it.each([true, false])(
  "keeps a child without a message time unsafe after v6 migration, seenWhileLive: %s",
  async (seenWhileLive) => {
    const legacy = vanishedChildFixture(null);
    const values = (await legacy.backing.read()).values;
    // v6 could clear this flag when a failed listing returned cached children.
    values.tasks[0].conversationAgents[0].seenWhileLive = seenWhileLive;
    const test = fixture(
      migrateData(
        {
          ...values,
          schemaVersion: 6,
          settings: { ...values.settings, autoArchive: true },
        },
        6,
      ),
    );
    test.inventory.workspaces = legacy.inventory.workspaces;
    test.inventory.agents = legacy.inventory.agents;
    test.host.conversation = legacy.host.conversation;
    for (let restart = 0; restart < 2; restart++) {
      const board = new Workboard(test.host, new Store(test.backing), test.now);
      try {
        await board.start();
        await board.refresh();
        expect(test.host.archive).not.toHaveBeenCalled();
        expect(board.snapshot().cards[0]).toMatchObject({
          conversationGateEvidence: "unknown",
          conversationGateAt: null,
          dueAt: null,
          archived: null,
        });
      } finally {
        board.dispose();
      }
    }
  },
);

it.each([5, 6])(
  "does not leave a v%s-migrated task permanently blocked by a never-observed legacy agent id",
  async (version) => {
    const migrated = migrateData(
      {
        schemaVersion: version,
        revision: 1,
        serverId: "fixture-host",
        settings: { autoArchive: true },
        tasks: [
          {
            ...newTask("task", "Old task", "2026-08-01T00:00:00Z", "done"),
            workspaceId: "old",
            lastStage: "done",
            lastConversationAt: "2026-08-01T00:00:00Z",
            conversationStatus: "known",
            conversationAgents:
              version === 5
                ? ["a", "a/provider/child"]
                : [{ id: "a", lastObservedAt: null, seenWhileLive: false }],
          },
        ],
      },
      version,
    );
    expect(migrated.tasks[0].conversationAgents).toEqual([]);
    const { board, inventory, host } = fixture(migrated);
    inventory.workspaces.push(workspace("old", undefined, ["task:done"]));
    inventory.agents.push({
      id: "a",
      workspaceId: "old",
      title: null,
      updatedAt: "2026-08-01T00:00:00Z",
      lastUserMessageAt: "2026-08-01T00:00:00Z",
      activity: "idle",
    });
    host.conversation = agentEvidence("2026-08-01T00:00:00Z");
    try {
      await board.start();
      const card = board.snapshot().cards.find((c) => c.workspaceId === "old")!;
      expect(card.conversationGateEvidence).toBe("exact");
      expect(host.archive).toHaveBeenCalledExactlyOnceWith("old");
    } finally {
      board.dispose();
    }
  },
);

it("shares scan inventory and exponentially defers unchanged unsafe candidates up to one hour", async () => {
  const test = dueFixture();
  test.inventory.workspaces.push(workspace("second", undefined, ["task:done"]));
  test.inventory.agents.push({
    ...test.inventory.agents[0],
    id: "b",
    workspaceId: "second",
  });
  let clock = test.now();
  const board = new Workboard(test.host, test.store, () => clock);
  test.host.inventory = vi.fn(test.host.inventory);
  test.host.conversation = vi.fn(test.host.conversation);
  test.host.safety = vi.fn(async () => "git-dirty");
  try {
    await board.start();
    expect(test.host.inventory).toHaveBeenCalledTimes(2); // Reconcile and one scan inventory for both candidates.
    expect(test.host.conversation).toHaveBeenCalledTimes(4);
    expect(test.host.safety).toHaveBeenCalledTimes(2);
    for (const delay of [60, 120, 240, 480, 960, 1920, 3600, 3600]) {
      vi.mocked(test.host.inventory).mockClear();
      vi.mocked(test.host.conversation).mockClear();
      vi.mocked(test.host.safety).mockClear();
      clock += delay * 1000 - 1;
      await board.refresh();
      expect(test.host.inventory).toHaveBeenCalledTimes(1);
      expect(test.host.conversation).not.toHaveBeenCalled();
      expect(test.host.safety).not.toHaveBeenCalled();
      expect(board.snapshot().cards.map((card) => card.issue)).toEqual([
        "git-dirty",
        "git-dirty",
      ]);
      clock++;
      await board.refresh();
      expect(test.host.inventory).toHaveBeenCalledTimes(3);
      expect(test.host.conversation).toHaveBeenCalledTimes(4);
      expect(test.host.safety).toHaveBeenCalledTimes(2);
      expect(test.host.archive).not.toHaveBeenCalled();
    }
    expect(test.store.current).not.toHaveProperty("archiveDeferrals");
  } finally {
    board.dispose();
  }
});

it.each([
  { archiveDoneEnabled: false },
  { archiveDoneEnabled: false, archiveCanceledEnabled: false },
  { archiveDoneAfterDays: 90 },
])(
  "clears obsolete archive warnings in the settings response before backoff expires: %j",
  async (change) => {
    const test = dueFixture();
    test.inventory.workspaces.push(
      workspace("canceled", undefined, ["task:canceled"]),
    );
    test.inventory.agents.push({
      ...test.inventory.agents[0],
      id: "c",
      workspaceId: "canceled",
    });
    test.host.safety = vi.fn(async () => "git-dirty");
    test.host.conversation = vi.fn(test.host.conversation);
    try {
      await test.board.start();
      expect(
        test.board.snapshot().cards.every((card) => card.issue === "git-dirty"),
      ).toBe(true);
      vi.mocked(test.host.conversation).mockClear();
      const before = test.board.snapshot();
      const saved = await test.board.mutate({
        action: "settings",
        revision: before.revision,
        expectedSettings: before.settings,
        settings: { ...before.settings, ...change },
      });
      expect(
        saved.cards.find((card) => card.workspaceId === "old")?.issue,
      ).toBe(null);
      expect(test.host.conversation).not.toHaveBeenCalled();
      expect(
        saved.cards.find((card) => card.workspaceId === "canceled")?.issue,
      ).toBe("archiveCanceledEnabled" in change ? null : "git-dirty");
      await test.board.refresh();
      expect(test.board.snapshot().cards.map((card) => card.issue)).toEqual(
        saved.cards.map((card) => card.issue),
      );
      expect(test.host.safety).toHaveBeenCalledTimes(2);
      expect(test.host.archive).not.toHaveBeenCalled();
    } finally {
      test.board.dispose();
    }
  },
);

it.each([true, false])(
  "rechecks safety after disabling and re-enabling without an intervening refresh at the same clock: dirty=%s",
  async (dirty) => {
    const test = dueFixture();
    test.host.safety = vi.fn(async () => "git-dirty");
    test.host.conversation = vi.fn(test.host.conversation);
    const setDone = async (enabled: boolean) => {
      const before = test.board.snapshot();
      return test.board.mutate({
        action: "settings",
        revision: before.revision,
        expectedSettings: before.settings,
        settings: { ...before.settings, archiveDoneEnabled: enabled },
      });
    };
    try {
      await test.board.start();
      expect((await setDone(false)).cards[0].issue).toBe(null);
      vi.mocked(test.host.safety).mockResolvedValue(dirty ? "git-dirty" : null);
      vi.mocked(test.host.safety).mockClear();
      vi.mocked(test.host.conversation).mockClear();
      await setDone(true);
      expect(test.host.conversation).not.toHaveBeenCalled();
      await test.board.refresh();
      expect(test.host.conversation).toHaveBeenCalledTimes(2);
      expect(test.host.safety).toHaveBeenCalledTimes(dirty ? 1 : 2);
      if (dirty) {
        expect(test.host.archive).not.toHaveBeenCalled();
        expect(test.board.snapshot().cards[0].issue).toBe("git-dirty");
      } else {
        expect(test.host.archive).toHaveBeenCalledExactlyOnceWith("old");
      }
    } finally {
      test.board.dispose();
    }
  },
);

it("preserves applicable backoff and skips history on unrelated settings saves", async () => {
  const test = dueFixture();
  test.host.safety = vi.fn(async () => "git-dirty");
  test.host.conversation = vi.fn(test.host.conversation);
  try {
    await test.board.start();
    vi.mocked(test.host.conversation).mockClear();
    const before = test.board.snapshot();
    const saved = await test.board.mutate({
      action: "settings",
      revision: before.revision,
      expectedSettings: before.settings,
      settings: { ...before.settings, pinInProgressWorkspaces: false },
    });
    expect(saved.cards[0].issue).toBe("git-dirty");
    await test.board.refresh();
    expect(test.host.conversation).not.toHaveBeenCalled();
    expect(test.host.safety).toHaveBeenCalledTimes(1);
  } finally {
    test.board.dispose();
  }
});

it("does not treat an unknown conversation gate as evidence that a longer delay is not due", async () => {
  const test = dueFixture();
  let clock = test.now();
  const board = new Workboard(test.host, test.store, () => clock);
  test.host.safety = vi.fn(async () => "git-dirty");
  try {
    await board.start();
    test.host.conversation = vi.fn(agentEvidence(null));
    clock += 60_000;
    await board.refresh();
    expect(board.snapshot().cards[0]).toMatchObject({
      conversationGateEvidence: "unknown",
      issue: "no-conversation",
    });
    const before = board.snapshot();
    const saved = await board.mutate({
      action: "settings",
      revision: before.revision,
      expectedSettings: before.settings,
      settings: { ...before.settings, archiveDoneAfterDays: 90 },
    });
    expect(saved.cards[0].issue).toBe("no-conversation");
    await board.refresh();
    expect(test.host.conversation).toHaveBeenCalledTimes(1);
    const disabled = await board.mutate({
      action: "settings",
      revision: saved.revision,
      expectedSettings: saved.settings,
      settings: { ...saved.settings, archiveDoneEnabled: false },
    });
    expect(disabled.cards[0].issue).toBe("no-conversation");
    expect(test.host.archive).not.toHaveBeenCalled();
  } finally {
    board.dispose();
  }
});

it("keeps an independent issue when clearing an owned archive deferral and checks new rules before refresh backoff", async () => {
  const test = dueFixture();
  test.host.safety = vi.fn(async () => "git-dirty");
  try {
    await test.board.start();
    await test.store.update((data) => {
      data.tasks[0].issue = "labels-conflict";
    });
    const before = test.board.snapshot();
    const saved = await test.board.mutate({
      action: "settings",
      revision: before.revision,
      expectedSettings: before.settings,
      settings: { ...before.settings, archiveDoneEnabled: false },
    });
    expect(saved.cards[0].issue).toBe("labels-conflict");
    // Simulate a loaded rule change while an in-memory deferral still exists.
    await test.store.update((data) => {
      data.settings.archiveDoneEnabled = true;
    });
    await test.board.refresh();
    expect(test.board.snapshot().cards[0].issue).toBe("git-dirty");
    await test.store.update((data) => {
      data.settings.archiveDoneEnabled = false;
    });
    await test.board.refresh();
    expect(test.board.snapshot().cards[0].issue).toBe(null);
    expect(test.host.archive).not.toHaveBeenCalled();
  } finally {
    test.board.dispose();
  }
});

it("keeps the existing deferral when saving the disabling rule fails", async () => {
  const test = dueFixture();
  test.host.safety = vi.fn(async () => "git-dirty");
  test.host.conversation = vi.fn(test.host.conversation);
  try {
    await test.board.start();
    vi.mocked(test.host.conversation).mockClear();
    vi.spyOn(test.backing, "write").mockRejectedValueOnce(
      new Error("storage failed"),
    );
    const before = test.board.snapshot();
    await expect(
      test.board.mutate({
        action: "settings",
        revision: before.revision,
        expectedSettings: before.settings,
        settings: { ...before.settings, archiveDoneEnabled: false },
      }),
    ).rejects.toThrow("storage failed");
    expect(test.store.current.settings.archiveDoneEnabled).toBe(true);
    expect(test.board.snapshot().cards[0].issue).toBe("git-dirty");
    await test.board.refresh();
    expect(test.host.conversation).not.toHaveBeenCalled();
    expect(test.host.safety).toHaveBeenCalledTimes(1);
  } finally {
    test.board.dispose();
  }
});

it("rechecks changed activity promptly and resets the backoff when the blocking reason changes", async () => {
  const test = dueFixture();
  let clock = test.now();
  const board = new Workboard(test.host, test.store, () => clock);
  test.inventory.agents[0].activity = "running";
  test.host.safety = vi.fn(async () => "git-dirty");
  test.host.conversation = vi.fn(test.host.conversation);
  try {
    await board.start();
    expect(board.snapshot().cards[0].issue).toBe("agent-busy");
    vi.mocked(test.host.conversation).mockClear();
    clock += 30_000;
    await board.refresh();
    expect(test.host.conversation).not.toHaveBeenCalled();
    expect(test.host.safety).not.toHaveBeenCalled();
    test.inventory.agents[0].activity = "idle";
    await board.refresh();
    expect(board.snapshot().cards[0].issue).toBe("git-dirty");
    expect(test.host.safety).toHaveBeenCalledTimes(1);
    clock += 60_000;
    await board.refresh(); // Same reason now waits 120 seconds.
    expect(test.host.safety).toHaveBeenCalledTimes(2);
    vi.mocked(test.host.safety).mockResolvedValue("git-no-upstream");
    clock += 120_000;
    await board.refresh();
    expect(board.snapshot().cards[0].issue).toBe("git-no-upstream");
    expect(test.host.safety).toHaveBeenCalledTimes(3);
    clock += 60_000;
    await board.refresh(); // New reason starts again at 60 seconds.
    expect(test.host.safety).toHaveBeenCalledTimes(4);
    expect(test.host.archive).not.toHaveBeenCalled();
  } finally {
    board.dispose();
  }
});

it("defers an unknown verification timeline and retries after the deadline", async () => {
  const test = dueFixture();
  let clock = test.now();
  const board = new Workboard(test.host, test.store, () => clock);
  test.host.conversation = vi.fn(async (_agent, _now, options) =>
    options?.recheck ? observed(null) : observed("2026-08-01T00:00:00Z"),
  );
  try {
    await board.start();
    expect(board.snapshot().cards[0].issue).toBe("conversation-unknown");
    expect(test.host.conversation).toHaveBeenCalledTimes(2);
    clock += 59_999;
    await board.refresh();
    expect(test.host.conversation).toHaveBeenCalledTimes(2);
    test.host.conversation = vi.fn(agentEvidence("2026-08-01T00:00:00Z"));
    clock++;
    await board.refresh();
    expect(test.host.archive).toHaveBeenCalledExactlyOnceWith("old");
  } finally {
    board.dispose();
  }
});

it("keeps each archive's final inventory confirmation even when candidates share scan inventory", async () => {
  const test = dueFixture();
  test.inventory.workspaces.push(workspace("second", undefined, ["task:done"]));
  test.inventory.agents.push({
    ...test.inventory.agents[0],
    id: "b",
    workspaceId: "second",
  });
  test.host.inventory = vi.fn(test.host.inventory);
  test.host.safety = vi.fn(async () => null);
  try {
    await test.board.start();
    expect(test.host.archive).toHaveBeenCalledTimes(2);
    expect(test.host.inventory).toHaveBeenCalledTimes(6); // Reconcile + shared scan + two pre-send + two post-send reads.
    expect(test.host.safety).toHaveBeenCalledTimes(4);
  } finally {
    test.board.dispose();
  }
});

it("clears process-local backoff on restart without weakening safety checks", async () => {
  const test = dueFixture();
  test.host.safety = vi.fn(async () => "git-dirty");
  await test.board.start();
  test.board.dispose();
  const reopened = new Workboard(test.host, new Store(test.backing), test.now);
  try {
    await reopened.start();
    expect(test.host.safety).toHaveBeenCalledTimes(2);
    expect(test.host.archive).not.toHaveBeenCalled();
    expect(reopened.snapshot().cards[0].issue).toBe("git-dirty");
  } finally {
    reopened.dispose();
  }
});

it("refuses native archive if the final inventory reveals activity without a change event", async () => {
  const test = dueFixture();
  const inventory = test.host.inventory;
  let reads = 0;
  test.host.inventory = vi.fn(async () => {
    if (++reads === 3) test.inventory.agents[0].activity = "running";
    return inventory();
  });
  try {
    await test.board.start();
    expect(test.host.inventory).toHaveBeenCalledTimes(3);
    expect(test.host.archive).not.toHaveBeenCalled();
    expect(test.board.snapshot().cards[0]).toMatchObject({
      archived: null,
      issue: "changed-during-check",
    });
  } finally {
    test.board.dispose();
  }
});

it("continues backoff when reconciliation itself loses the conversation gate", async () => {
  const test = dueFixture();
  let clock = test.now();
  const board = new Workboard(test.host, test.store, () => clock);
  test.host.safety = vi.fn(async () => "git-dirty");
  try {
    await board.start();
    test.host.conversation = vi.fn(agentEvidence(null));
    clock += 60_000;
    await board.refresh();
    expect(board.snapshot().cards[0].conversationGateEvidence).toBe("unknown");
    expect(test.host.conversation).toHaveBeenCalledTimes(1);
    clock += 60_000; // First conversation failure retries at 60 seconds.
    await board.refresh();
    expect(test.host.conversation).toHaveBeenCalledTimes(2);
    clock += 60_000; // Same failure now waits 120 seconds.
    await board.refresh();
    expect(test.host.conversation).toHaveBeenCalledTimes(2);
    expect(test.host.safety).toHaveBeenCalledTimes(1);
    expect(test.host.archive).not.toHaveBeenCalled();
  } finally {
    board.dispose();
  }
});

it("rechecks ownership readiness at the same clock after a git-unknown deferral, preserving the archive gates", async () => {
  const test = dueFixture();
  const native = test.inventory.workspaces[0];
  native.projectKind = "git";
  native.workspaceKind = "worktree";
  test.host.safety = vi.fn(async (workspace) =>
    workspace.gitRuntime?.isPaseoOwnedWorktree === true ? null : "git-unknown",
  );
  await test.board.start();
  try {
    expect(test.board.snapshot().cards[0]).toMatchObject({
      issue: "git-unknown",
      archived: null,
      conversationGateEvidence: "exact",
    });
    expect(test.host.archive).not.toHaveBeenCalled();
    const before = test.now();
    native.gitRuntime = { isPaseoOwnedWorktree: true } as NonNullable<
      typeof native.gitRuntime
    >;
    await test.board.refresh();
    expect(test.now()).toBe(before);
    expect(test.host.safety).toHaveBeenCalledTimes(3); // Initial rejection, candidate check, final pre-send check.
    expect(test.host.archive).toHaveBeenCalledExactlyOnceWith("old");
    expect(test.board.snapshot().cards[0]).toMatchObject({
      conversationGateEvidence: "exact",
      conversationGateAt: "2026-08-01T00:00:00.000Z",
      archived: { status: "archived" },
    });
  } finally {
    test.board.dispose();
  }
});

import { expect, it, vi } from "vitest";
import { Store } from "../server/store";
import { Workboard } from "../server/workboard";
import { boardSchema, DEFAULT_GROUPS, settingsSchema } from "../shared/model";
import { mutationSchema } from "../shared/rpc";
import { agentEvidence, fixture, observed, workspace } from "./fixtures";
import { visibleCards } from "../client/board-utils";

const pullRequest = {
  number: 42,
  url: "https://code.example/team/repo/-/merge_requests/42",
  title: "Fix workspace sync",
  state: "OPEN",
  baseRefName: "main",
  headRefName: "fix-sync",
  isMerged: false,
  isDraft: true,
  checksStatus: "pending" as const,
  reviewDecision: "changes_requested" as const,
};

it("imports unlabeled workspaces into Inbox while drafts and explicit To do labels stay in To do", async () => {
  const { board, inventory, host } = fixture();
  inventory.workspaces.push(
    workspace("native", "Native workspace", ["project:demo"]),
    workspace("planned", "Planned workspace", ["task:todo"]),
  );
  await board.start();
  try {
    expect(
      board
        .snapshot()
        .cards.map(({ workspaceId, stage }) => ({ workspaceId, stage })),
    ).toEqual([
      { workspaceId: "native", stage: "inbox" },
      { workspaceId: "planned", stage: "todo" },
    ]);
    expect(host.setLabel).not.toHaveBeenCalled();
    const view = await board.mutate({
      action: "create",
      title: "Idea",
      description: "",
      projectId: null,
    });
    const draft = view.cards.find((card) => card.workspaceId === null)!;
    expect(draft.stage).toBe("todo");
    const moved = await board.mutate({
      action: "stage",
      taskId: draft.id,
      stage: "inbox",
      expectedLabels: [],
    });
    expect(moved.cards.find((card) => card.id === draft.id)).toMatchObject({
      workspaceId: null,
      stage: "inbox",
    });
    expect(host.create).not.toHaveBeenCalled();
    inventory.workspaces[1].labels = [];
    await board.refresh();
    expect(
      board.snapshot().cards.find((card) => card.workspaceId === "planned")
        ?.stage,
    ).toBe("inbox");
  } finally {
    board.dispose();
  }
});

it("creates a draft in an explicit To do group without creating a workspace or agent", async () => {
  const { board, host, inventory } = fixture({
    settings: settingsSchema.parse({
      groups: [
        ...DEFAULT_GROUPS,
        {
          id: "ready",
          kind: "todo",
          name: "Ready",
          label: "task:ready",
        },
      ],
    }),
  });
  inventory.projects.push({
    id: "project-1",
    name: "Project one",
    directory: "/project-1",
    isGit: true,
  });
  await board.start();
  try {
    const view = await board.mutate(
      mutationSchema.parse({
        action: "create",
        title: "Ready draft",
        description: "No workspace yet",
        projectId: "project-1",
        stage: "ready",
      }),
    );
    expect(view.cards).toMatchObject([
      {
        title: "Ready draft",
        workspaceId: null,
        stage: "ready",
        projectId: "project-1",
        projectName: "Project one",
      },
    ]);
    expect(host.create).not.toHaveBeenCalled();
    expect(inventory.agents).toEqual([]);
  } finally {
    board.dispose();
  }
});

it("keeps new drafts in the default To do group when create omits stage", async () => {
  const { board } = fixture();
  await board.start();
  try {
    const view = await board.mutate(
      mutationSchema.parse({
        action: "create",
        title: "Default draft",
        description: "",
        projectId: null,
      }),
    );
    expect(view.cards[0]?.stage).toBe("todo");
  } finally {
    board.dispose();
  }
});

it("rejects a create stage that is not a To do group before persisting", async () => {
  const { board, store } = fixture();
  await board.start();
  try {
    const revision = board.snapshot().revision;
    await expect(
      board.mutate(
        mutationSchema.parse({
          action: "create",
          title: "Cannot start from here",
          description: "",
          projectId: null,
          stage: "in-progress",
        }),
      ),
    ).rejects.toThrow("To do");
    expect(store.current.revision).toBe(revision);
    expect(store.current.tasks).toEqual([]);
  } finally {
    board.dispose();
  }
});

it("projects native pin ownership from the current workspace timestamp", async () => {
  const { board, inventory } = fixture({
    autoPins: { automatic: "2026-09-24T00:00:00.000Z" },
  });
  inventory.workspaces.push(
    {
      ...workspace("automatic", "Automatic", ["task:in-progress"]),
      pinnedAt: "2026-09-24T00:00:00.000Z",
    },
    {
      ...workspace("manual", "Manual", ["task:review"]),
      pinnedAt: "2026-09-24T00:01:00.000Z",
    },
    workspace("none", "None", ["task:review"]),
  );
  await board.start();
  try {
    expect(
      boardSchema
        .parse(board.snapshot())
        .cards.map(({ workspaceId, pinState }) => ({ workspaceId, pinState })),
    ).toEqual([
      { workspaceId: "automatic", pinState: "automatic" },
      { workspaceId: "manual", pinState: "manual" },
      { workspaceId: "none", pinState: "none" },
    ]);
  } finally {
    board.dispose();
  }
});

it("keeps another agent's actionable status visible while a workspace is running, then clears attention after recovery", async () => {
  const { board, host, inventory } = fixture();
  inventory.workspaces.push(workspace("w", "Mixed agents", ["task:review"]));
  const agent = {
    title: null,
    workspaceId: "w",
    updatedAt: "2026-09-23T00:00:00Z",
    lastUserMessageAt: "2026-09-23T00:00:00Z",
  };
  inventory.agents.push(
    { ...agent, id: "worker", activity: "running" },
    { ...agent, id: "needs-action", activity: "error" },
    {
      ...agent,
      id: "archived-permission",
      activity: "waiting",
      archivedAt: "2026-09-22T00:00:00Z",
    },
  );
  host.conversation = agentEvidence("2026-09-23T00:00:00Z");
  await board.start();
  try {
    for (const activity of ["error", "attention", "waiting"] as const) {
      inventory.agents[1].activity = activity;
      await board.refresh();
      const current = boardSchema.parse(board.snapshot());
      expect(current.cards[0]).toMatchObject({
        activity,
        stage: "review",
        issue: null,
      });
      expect(
        visibleCards(current, "all", "", true).map((card) => card.workspaceId),
      ).toEqual(["w"]);
      expect(
        current.cards[0].agents.find((agent) => agent.id === "worker")
          ?.activity,
      ).toBe("running");
    }
    inventory.agents[1].activity = "idle";
    await board.refresh();
    const recovered = board.snapshot();
    expect(recovered.cards[0]).toMatchObject({
      activity: "running",
      stage: "review",
      issue: null,
    });
    expect(visibleCards(recovered, "all", "", true)).toEqual([]);
    expect(
      recovered.cards[0].agents.find((agent) => agent.id === "worker")
        ?.activity,
    ).toBe("running");
    expect(host.setLabel).not.toHaveBeenCalled();
  } finally {
    board.dispose();
  }
});

it("clears only a lastError-only idle Agent after a newer user message", async () => {
  const { board, inventory } = fixture();
  inventory.workspaces.push(workspace("w", "Recovered", ["task:review"]));
  const agent = {
    title: null,
    workspaceId: "w",
    lastUserMessageAt: null,
  };
  inventory.agents.push(
    {
      ...agent,
      id: "historical-error",
      activity: "error",
      status: "idle",
      lastError: "Previous turn failed",
      updatedAt: "2026-09-23T00:00:00Z",
    },
    {
      ...agent,
      id: "current-running",
      activity: "running",
      lastUserMessageAt: "2026-09-23T00:01:00Z",
      updatedAt: "2026-09-23T00:01:00Z",
    },
  );
  await board.start();
  try {
    expect(board.snapshot().cards[0].activity).toBe("running");
    expect(board.snapshot().cards[0].agents[0].activity).toBe("error");

    inventory.agents[0].updatedAt = "2026-09-23T00:02:00Z";
    await board.refresh();
    expect(board.snapshot().cards[0].activity).toBe("error");

    inventory.agents[0].updatedAt = "2026-09-23T00:03:00Z";
    inventory.agents[1].activity = "idle";
    inventory.agents[1].lastUserMessageAt = "2026-09-23T00:04:00Z";
    inventory.agents[1].updatedAt = "2026-09-23T00:04:00Z";
    await board.refresh();
    expect(board.snapshot().cards[0].activity).toBe("idle");
  } finally {
    board.dispose();
  }
});

it.each([
  { status: "error" as const },
  { status: "idle" as const, attentionReason: "error" as const },
  { parentAgentId: "parent", subagentId: "failed-child" },
  {},
])(
  "keeps unresolved errors visible despite a newer worker: %j",
  async (source) => {
    const { board, inventory } = fixture();
    inventory.workspaces.push(workspace("w", "Parallel", ["task:review"]));
    const agent = { title: null, workspaceId: "w", lastUserMessageAt: null };
    inventory.agents.push(
      {
        ...agent,
        ...source,
        id: "failed-worker",
        activity: "error",
        lastError: "Turn failed",
        updatedAt: "2026-09-23T00:01:00Z",
      },
      {
        ...agent,
        id: "other-worker",
        activity: "running",
        lastUserMessageAt: "2026-09-23T00:02:00Z",
        updatedAt: "2026-09-23T00:02:00Z",
      },
    );
    await board.start();
    try {
      expect(board.snapshot().cards[0].activity).toBe("error");
      expect(visibleCards(board.snapshot(), "all", "", true)).toHaveLength(1);
    } finally {
      board.dispose();
    }
  },
);

it("does not clear a lastError-only Agent when an old idle Agent is renamed", async () => {
  const { board, inventory } = fixture();
  inventory.workspaces.push(workspace("w", "Metadata", ["task:review"]));
  const agent = { title: null, workspaceId: "w", lastUserMessageAt: null };
  inventory.agents.push(
    {
      ...agent,
      id: "historical-error",
      activity: "error",
      status: "idle",
      lastError: "Previous turn failed",
      updatedAt: "2026-09-23T00:01:00Z",
    },
    {
      ...agent,
      id: "old-idle",
      activity: "idle",
      lastUserMessageAt: "2026-09-23T00:00:00Z",
      updatedAt: "2026-09-23T00:00:00Z",
    },
  );
  await board.start();
  try {
    expect(board.snapshot().cards[0].activity).toBe("error");
    inventory.agents[1].title = "Renamed";
    inventory.agents[1].updatedAt = "2026-09-23T00:02:00Z";
    await board.refresh();
    expect(board.snapshot().cards[0].activity).toBe("error");
    expect(visibleCards(board.snapshot(), "all", "", true)).toHaveLength(1);
  } finally {
    board.dispose();
  }
});

it.each([
  { lastUserMessageAt: null },
  { lastUserMessageAt: "invalid" },
  { lastUserMessageAt: "2026-09-23T00:01:00Z" },
  {
    lastUserMessageAt: "2026-09-23T00:02:00Z",
    archivedAt: "2026-09-23T00:03:00Z",
  },
])(
  "requires a strictly newer live user message to clear leftover errors: %j",
  async (evidence) => {
    const { board, inventory } = fixture();
    inventory.workspaces.push(workspace("w", "Uncertain", ["task:review"]));
    const agent = { title: null, workspaceId: "w", lastUserMessageAt: null };
    inventory.agents.push(
      {
        ...agent,
        id: "historical-error",
        activity: "error",
        status: "idle",
        lastError: "Previous turn failed",
        updatedAt: "2026-09-23T00:01:00Z",
      },
      {
        ...agent,
        ...evidence,
        id: "other-worker",
        activity: "idle",
        updatedAt: "2026-09-23T00:04:00Z",
      },
    );
    await board.start();
    try {
      expect(board.snapshot().cards[0].activity).toBe("error");
    } finally {
      board.dispose();
    }
  },
);

it("keeps the parent's current error visible beside a replayed idle provider child", async () => {
  const { board, inventory, host } = fixture();
  inventory.workspaces.push(
    workspace("w", "Parent and child", ["task:review"]),
  );
  inventory.agents.push(
    {
      id: "parent",
      workspaceId: "w",
      title: "Parent",
      updatedAt: "2026-09-23T00:00:00Z",
      lastUserMessageAt: null,
      activity: "error",
    },
    {
      id: "parent/provider/child",
      parentAgentId: "parent",
      subagentId: "child",
      workspaceId: "w",
      title: "Child",
      updatedAt: "2026-09-23T00:01:00Z",
      lastUserMessageAt: null,
      activity: "idle",
    },
  );
  host.conversation = async (agent) =>
    agent.id === "parent"
      ? observed("2026-09-22T00:00:00Z")
      : observed(null, {
          display: "unknown",
          gate: "unknown",
          reason: "replay-timestamp",
        });
  await board.start();
  try {
    const card = board.snapshot().cards[0];
    expect(card.activity).toBe("error");
    expect(card.lastConversationAt).toBe("2026-09-22T00:00:00.000Z");
    expect(card.agents).toMatchObject([
      { id: "parent", activity: "error" },
      { id: "parent/provider/child", activity: "idle" },
    ]);
  } finally {
    board.dispose();
  }
});

it("saves the sidebar In progress pin preference through the RPC contract and keeps it after restart", async () => {
  const { board, host, backing, inventory, now } = fixture();
  inventory.workspaces.push(workspace("task", "Task", ["task:review"]));
  await board.start();
  const reopened = new Workboard(host, new Store(backing), now);
  try {
    const current = board.snapshot();
    expect(current.settings.pinInProgressWorkspaces).toBe(true);
    const updated = await board.mutate(
      mutationSchema.parse({
        action: "settings",
        revision: current.revision,
        settings: { ...current.settings, pinInProgressWorkspaces: false },
      }),
    );
    expect(updated.settings.pinInProgressWorkspaces).toBe(false);
    await reopened.start();
    expect(reopened.snapshot().settings.pinInProgressWorkspaces).toBe(false);
    expect(reopened.snapshot().cards[0].stage).toBe("review");
    expect(host.setLabel).not.toHaveBeenCalled();
    expect(host.archive).not.toHaveBeenCalled();
  } finally {
    board.dispose();
    reopened.dispose();
  }
});

it("projects native MR details through the board RPC, updates them and clears removed associations without changing task stage", async () => {
  const { board, inventory, store } = fixture();
  const linked = {
    ...workspace("linked", "Task", ["task:review"]),
    forge: "gitlab",
    githubRuntime: { pullRequest: { ...pullRequest } },
  };
  inventory.workspaces.push(linked, workspace("plain"));
  await board.start();
  try {
    const snapshot = () => boardSchema.parse(board.snapshot());
    expect(snapshot().cards[0]).toMatchObject({
      stage: "review",
      changeRequest: {
        forge: "gitlab",
        number: 42,
        url: pullRequest.url,
        title: "Fix workspace sync",
        state: "draft",
        checksStatus: "pending",
        reviewDecision: "changes_requested",
      },
    });
    expect(snapshot().cards[1].changeRequest).toBeNull();
    const withDraft = await board.mutate({
      action: "create",
      title: "Idea",
      description: "",
      projectId: null,
    });
    expect(
      withDraft.cards.find((card) => !card.workspaceId)?.changeRequest,
    ).toBeNull();
    linked.githubRuntime.pullRequest.isMerged = true;
    await board.refresh();
    expect(snapshot().cards[0]).toMatchObject({
      stage: "review",
      changeRequest: { state: "merged" },
    });
    expect(store.current.tasks[0]).not.toHaveProperty("changeRequest");
    inventory.workspaces[0] = {
      ...linked,
      githubRuntime: { pullRequest: null },
    };
    await board.refresh();
    expect(snapshot().cards[0].changeRequest).toBeNull();
    inventory.workspaces[0].githubRuntime = {
      pullRequest: null,
      error: { message: "Refresh failed" },
    };
    await board.refresh();
    expect(snapshot().cards[0]).toMatchObject({
      changeRequest: null,
      changeRequestUnavailable: true,
      stage: "review",
    });
  } finally {
    board.dispose();
  }
});

it.each([
  ["OPEN", false, false, "open"],
  ["opened", false, false, "open"],
  ["CLOSED", false, true, "closed"],
  ["merged", false, true, "merged"],
  ["unrecognized", false, false, "unknown"],
])(
  "keeps native change-request state %s distinct from task state",
  async (state, isMerged, isDraft, expected) => {
    const { board, inventory } = fixture();
    inventory.workspaces.push({
      ...workspace("w"),
      githubRuntime: {
        pullRequest: {
          ...pullRequest,
          state,
          isMerged,
          isDraft,
          number: undefined,
        },
      },
    });
    await board.start();
    try {
      expect(boardSchema.parse(board.snapshot()).cards[0]).toMatchObject({
        stage: "inbox",
        changeRequest: {
          forge: "github",
          number: null,
          state: expected,
        },
      });
    } finally {
      board.dispose();
    }
  },
);

it("creates only a persistent draft, then binds without losing notes or duplicating an imported workspace", async () => {
  const { board, host, backing, inventory, now } = fixture();
  await board.start();
  try {
    let view = await board.mutate({
      action: "create",
      title: "Idea",
      description: "Plan",
      projectId: null,
    });
    expect(view.cards).toHaveLength(1);
    expect(view.cards[0].workspaceId).toBeNull();
    expect(host.create).not.toHaveBeenCalled();
    const id = view.cards[0].id;
    inventory.workspaces.push(workspace("existing"));
    await board.refresh();
    await board.refresh();
    expect(board.snapshot().cards).toHaveLength(2);
    view = await board.mutate({
      action: "start",
      taskId: id,
      target: { kind: "existing", workspaceId: "existing" },
    });
    expect(view.cards).toHaveLength(1);
    expect(view.cards[0]).toMatchObject({
      workspaceId: "existing",
      stage: "in-progress",
    });
    expect(view.cards[0].description).toContain("Idea");
    expect(view.cards[0].description).toContain("Plan");
    const reopened = new Workboard(host, new Store(backing), now);
    await reopened.start();
    expect(reopened.snapshot().cards).toHaveLength(1);
    reopened.dispose();
  } finally {
    board.dispose();
  }
});
it("recovers a lost create response with the persisted idempotency key and no second workspace", async () => {
  const { board, host, backing, now } = fixture();
  await board.start();
  const create = host.create;
  let first = true;
  host.create = vi.fn(async (source, title, key) => {
    const id = await create(source, title, key);
    if (first) {
      first = false;
      throw new Error("Response lost");
    }
    return id;
  });
  try {
    const card = (
      await board.mutate({
        action: "create",
        title: "Keep",
        description: "Notes",
        projectId: null,
      })
    ).cards[0];
    await expect(
      board.mutate({
        action: "start",
        taskId: card.id,
        target: {
          kind: "new",
          source: { kind: "directory", path: "/fixture" },
        },
      }),
    ).rejects.toThrow("Response lost");
    board.dispose();
    const resumed = new Workboard(host, new Store(backing), now);
    await resumed.start();
    expect(resumed.snapshot().cards).toHaveLength(1);
    expect(resumed.snapshot().cards[0]).toMatchObject({
      id: card.id,
      workspaceId: "w1",
      description: "Notes",
      stage: "in-progress",
      binding: null,
    });
    expect(vi.mocked(host.create).mock.calls[0][2]).toBe(
      vi.mocked(host.create).mock.calls[1][2],
    );
    resumed.dispose();
  } finally {
    board.dispose();
  }
});
it("preserves ordinary labels, observes native changes and rejects stale transitions", async () => {
  const { board, inventory } = fixture({
    settings: settingsSchema.parse({ exclusiveStatusLabels: false }),
  });
  inventory.workspaces.push(
    workspace("w", undefined, ["customer", "task:todo"]),
  );
  await board.start();
  try {
    const card = board.snapshot().cards[0];
    const done = await board.mutate({
      action: "stage",
      taskId: card.id,
      stage: "done",
      expectedLabels: ["task:todo"],
    });
    expect(done.cards[0].labels.sort()).toEqual(["customer", "task:done"]);
    inventory.workspaces[0].labels = ["customer", "task:review"];
    await board.refresh();
    expect(board.snapshot().cards[0].stage).toBe("review");
    await expect(
      board.mutate({
        action: "stage",
        taskId: card.id,
        stage: "done",
        expectedLabels: ["task:done"],
      }),
    ).rejects.toThrow();
    inventory.workspaces[0].labels.push("task:done");
    await board.refresh();
    expect(board.snapshot().cards[0].stage).toBe("conflict");
  } finally {
    board.dispose();
  }
});
it("returns a verified stage change without waiting for unrelated inventory or history", async () => {
  const { board, host, inventory, store } = fixture();
  inventory.workspaces.push(workspace("w", "Task", ["customer", "task:todo"]));
  await board.start();
  const inventoryRead = vi.fn(host.inventory);
  host.inventory = inventoryRead;
  host.conversation = vi.fn(host.conversation);
  try {
    const result = await board.mutate({
      action: "stage",
      taskId: board.snapshot().cards[0].id,
      stage: "review",
      expectedLabels: ["task:todo"],
    });
    expect(result.cards[0]).toMatchObject({
      stage: "review",
      labels: ["customer", "task:review"],
      managedLabels: ["task:review"],
    });
    expect(store.current.tasks[0].lastStage).toBe("review");
    expect(inventoryRead).not.toHaveBeenCalled();
    expect(host.conversation).not.toHaveBeenCalled();
  } finally {
    board.dispose();
  }
});

it("coalesces events during a slow refresh and yields to mutations before the follow-up", async () => {
  vi.useFakeTimers();
  const { board, host, inventory } = fixture();
  for (const id of ["a", "b"]) {
    inventory.workspaces.push(workspace(id));
    inventory.agents.push({
      id,
      title: id,
      workspaceId: id,
      updatedAt: "2026-09-01T00:00:00Z",
      lastUserMessageAt: null,
      activity: "idle",
    });
  }
  await board.start();
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reading = new Promise<void>((resolve) => {
    entered = resolve;
  });
  host.conversation = vi.fn(async (agent) => {
    if (agent.id === "a") {
      entered();
      await blocked;
    }
    return observed("2026-09-01T00:00:00Z");
  });
  const read = vi.mocked(host.conversation);
  try {
    const refresh = board.refresh();
    await reading;
    for (let i = 0; i < 4; i++) {
      board.changed("b");
      await vi.advanceTimersByTimeAsync(350);
    }
    const mutation = board.mutate({
      action: "create",
      title: "During refresh",
      description: "",
      projectId: null,
    });
    release();
    await refresh;
    expect(
      (await mutation).cards.some((card) => card.title === "During refresh"),
    ).toBe(true);
    expect(read.mock.calls.map(([agent]) => agent.id)).toEqual(["a", "b"]);
    await vi.advanceTimersByTimeAsync(300);
    expect(read.mock.calls.map(([agent]) => agent.id)).toEqual(["a", "b", "b"]);
    board.changed("a");
    board.changed("b");
    await vi.advanceTimersByTimeAsync(300);
    expect(read.mock.calls.map(([agent]) => agent.id)).toEqual([
      "a",
      "b",
      "b",
      "a",
      "b",
    ]);
  } finally {
    release();
    board.dispose();
    vi.useRealTimers();
  }
});
it("stops a partial transition when a native editor adds another managed label", async () => {
  const { board, host, inventory } = fixture();
  inventory.workspaces.push(
    workspace("w", undefined, ["customer", "task:todo"]),
  );
  await board.start();
  const set = host.setLabel;
  host.setLabel = vi.fn(async (id, name, color, assigned) => {
    await set(id, name, color, assigned);
    inventory.workspaces[0].labels.push("task:review");
    return inventory.workspaces[0].labels;
  });
  try {
    await expect(
      board.mutate({
        action: "stage",
        taskId: board.snapshot().cards[0].id,
        stage: "done",
        expectedLabels: ["task:todo"],
      }),
    ).rejects.toThrow("changed");
    expect(host.setLabel).toHaveBeenCalledTimes(1);
    expect(inventory.workspaces[0].labels).toContain("task:review");
    expect(inventory.workspaces[0].labels).toContain("customer");
  } finally {
    board.dispose();
  }
});
it("refuses a foreign host's persisted data without touching its workspaces", async () => {
  const { board, host } = fixture({ serverId: "another-host" });
  try {
    await expect(board.start()).rejects.toThrow("another Paseo host");
    expect(host.create).not.toHaveBeenCalled();
    expect(host.archive).not.toHaveBeenCalled();
  } finally {
    board.dispose();
  }
});

it("resolves an externally added status label by default", async () => {
  const { board, host, inventory, store } = fixture();
  inventory.workspaces.push(workspace("w", "Task", ["customer", "task:todo"]));
  await board.start();
  try {
    inventory.workspaces[0].labels = ["customer", "task:todo", "task:done"];
    await board.refresh();
    expect(board.snapshot().cards[0]).toMatchObject({
      stage: "done",
      labels: ["customer", "task:done"],
      managedLabels: ["task:done"],
      issue: null,
    });
    expect(host.setLabel).toHaveBeenCalledWith(
      "w",
      "task:todo",
      "emerald",
      false,
    );
    expect(store.current.tasks[0]).toMatchObject({
      lastStage: "done",
      issue: null,
    });
  } finally {
    board.dispose();
  }
});
it("keeps an unattributable conflict manual when no single newcomer exists", async () => {
  const { board, inventory } = fixture();
  inventory.workspaces.push(workspace("w", "Task", ["customer", "task:todo"]));
  await board.start();
  try {
    const view = board.snapshot();
    await board.mutate({
      action: "settings",
      revision: view.revision,
      expectedSettings: view.settings,
      settings: { ...view.settings, exclusiveStatusLabels: true },
    });
    inventory.workspaces[0].labels = ["customer", "task:review", "task:done"];
    await board.refresh();
    expect(board.snapshot().cards[0]).toMatchObject({
      stage: "conflict",
      issue: "labels-conflict",
    });
  } finally {
    board.dispose();
  }
});
it("keeps the conflict banner when the newest-wins sync fails", async () => {
  const { board, host, inventory } = fixture();
  inventory.workspaces.push(workspace("w", "Task", ["customer", "task:todo"]));
  await board.start();
  try {
    const view = board.snapshot();
    await board.mutate({
      action: "settings",
      revision: view.revision,
      expectedSettings: view.settings,
      settings: { ...view.settings, exclusiveStatusLabels: true },
    });
    host.setLabel = vi.fn(async () => {
      throw new Error("Bridge unavailable");
    });
    inventory.workspaces[0].labels = ["customer", "task:todo", "task:done"];
    await board.refresh();
    expect(board.snapshot().cards[0]).toMatchObject({
      stage: "conflict",
      issue: "labels-conflict",
    });
  } finally {
    board.dispose();
  }
});
it("keeps conflicts manual when exclusivity is explicitly off", async () => {
  const { board, inventory } = fixture({
    settings: settingsSchema.parse({ exclusiveStatusLabels: false }),
  });
  inventory.workspaces.push(workspace("w", "Task", ["customer", "task:todo"]));
  await board.start();
  try {
    inventory.workspaces[0].labels = ["customer", "task:todo", "task:done"];
    await board.refresh();
    expect(board.snapshot().cards[0]).toMatchObject({
      stage: "conflict",
      issue: "labels-conflict",
    });
  } finally {
    board.dispose();
  }
});
it("resolves a label re-added externally after a board move before the next refresh", async () => {
  // Fake timers hold back the debounced refresh the move schedules, so the
  // external edit lands while the board still considers the move the newest
  // change and no intermediate refresh runs.
  vi.useFakeTimers();
  const { board, host, inventory, store } = fixture();
  inventory.workspaces.push(workspace("w", "Task", ["customer", "task:done"]));
  await board.start();
  try {
    const view = board.snapshot();
    await board.mutate({
      action: "settings",
      revision: view.revision,
      expectedSettings: view.settings,
      settings: { ...view.settings, exclusiveStatusLabels: true },
    });
    await board.mutate({
      action: "stage",
      taskId: board.snapshot().cards[0].id,
      stage: "in-progress",
      expectedLabels: ["task:done"],
    });
    inventory.workspaces[0].labels = [
      "customer",
      "task:in-progress",
      "task:done",
    ];
    await board.refresh();
    expect(board.snapshot().cards[0]).toMatchObject({
      stage: "done",
      labels: ["customer", "task:done"],
      managedLabels: ["task:done"],
      issue: null,
    });
    expect(host.setLabel).toHaveBeenCalledWith(
      "w",
      "task:in-progress",
      "emerald",
      false,
    );
    expect(store.current.tasks[0]).toMatchObject({
      lastStage: "done",
      resolvedStage: "done",
      issue: null,
    });
  } finally {
    board.dispose();
    vi.useRealTimers();
  }
});
it("resolves a third stage's label added externally after a board move", async () => {
  vi.useFakeTimers();
  const { board, host, inventory } = fixture();
  inventory.workspaces.push(workspace("w", "Task", ["customer", "task:done"]));
  await board.start();
  try {
    const view = board.snapshot();
    await board.mutate({
      action: "settings",
      revision: view.revision,
      expectedSettings: view.settings,
      settings: { ...view.settings, exclusiveStatusLabels: true },
    });
    await board.mutate({
      action: "stage",
      taskId: board.snapshot().cards[0].id,
      stage: "in-progress",
      expectedLabels: ["task:done"],
    });
    inventory.workspaces[0].labels = [
      "customer",
      "task:in-progress",
      "task:review",
    ];
    await board.refresh();
    expect(board.snapshot().cards[0]).toMatchObject({
      stage: "review",
      labels: ["customer", "task:review"],
      managedLabels: ["task:review"],
      issue: null,
    });
    expect(host.setLabel).toHaveBeenCalledWith(
      "w",
      "task:in-progress",
      "orange",
      false,
    );
  } finally {
    board.dispose();
    vi.useRealTimers();
  }
});
it("resolves a label added externally between binding and reconciliation", async () => {
  vi.useFakeTimers();
  const { board, host, inventory, store } = fixture();
  inventory.workspaces.push(workspace("w", "Task", ["customer", "task:done"]));
  await board.start();
  try {
    const view = board.snapshot();
    await board.mutate({
      action: "settings",
      revision: view.revision,
      expectedSettings: view.settings,
      settings: { ...view.settings, exclusiveStatusLabels: true },
    });
    const draft = (
      await board.mutate({
        action: "create",
        title: "Idea",
        description: "",
        projectId: null,
      })
    ).cards.find((card) => card.title === "Idea")!;
    // The external edit lands when the post-binding reconciliation reads the
    // inventory: after the verified transition, before the baseline is used.
    const readInventory = host.inventory;
    host.inventory = async () => {
      const w = inventory.workspaces.find((w) => w.id === "w")!;
      if (!w.labels.includes("task:done")) w.labels.push("task:done");
      return readInventory();
    };
    const started = await board.mutate({
      action: "start",
      taskId: draft.id,
      target: { kind: "existing", workspaceId: "w" },
      stage: "in-progress",
    });
    expect(started.cards).toHaveLength(1);
    expect(started.cards[0]).toMatchObject({
      workspaceId: "w",
      stage: "done",
      labels: ["customer", "task:done"],
      managedLabels: ["task:done"],
      issue: null,
    });
    expect(host.setLabel).toHaveBeenCalledWith(
      "w",
      "task:in-progress",
      "emerald",
      false,
    );
    expect(store.current.tasks[0]).toMatchObject({
      workspaceId: "w",
      lastStage: "done",
      resolvedStage: "done",
      issue: null,
    });
  } finally {
    board.dispose();
    vi.useRealTimers();
  }
});
it("resolves a standing conflict when exclusivity is enabled afterwards", async () => {
  const { board, inventory } = fixture({
    settings: settingsSchema.parse({ exclusiveStatusLabels: false }),
  });
  inventory.workspaces.push(workspace("w", "Task", ["customer", "task:todo"]));
  await board.start();
  try {
    inventory.workspaces[0].labels = ["customer", "task:todo", "task:done"];
    await board.refresh();
    expect(board.snapshot().cards[0].stage).toBe("conflict");
    const view = board.snapshot();
    await board.mutate({
      action: "settings",
      revision: view.revision,
      expectedSettings: view.settings,
      settings: { ...view.settings, exclusiveStatusLabels: true },
    });
    // The debounced refresh triggered by the save applies the persisted baseline.
    await board.refresh();
    expect(board.snapshot().cards[0]).toMatchObject({
      stage: "done",
      managedLabels: ["task:done"],
      issue: null,
    });
  } finally {
    board.dispose();
  }
});
it("retries the newest-wins sync after a transient failure", async () => {
  const { board, host, inventory } = fixture();
  inventory.workspaces.push(workspace("w", "Task", ["customer", "task:todo"]));
  await board.start();
  try {
    const view = board.snapshot();
    await board.mutate({
      action: "settings",
      revision: view.revision,
      expectedSettings: view.settings,
      settings: { ...view.settings, exclusiveStatusLabels: true },
    });
    host.setLabel = vi.fn(async () => {
      throw new Error("Bridge unavailable");
    });
    inventory.workspaces[0].labels = ["customer", "task:todo", "task:done"];
    await board.refresh();
    expect(board.snapshot().cards[0].stage).toBe("conflict");
    host.setLabel = vi.fn(async (id, name, _color, assigned) => {
      const w = inventory.workspaces.find((w) => w.id === id)!;
      w.labels = w.labels.filter((label) => label !== name);
      if (assigned) w.labels.push(name);
      return w.labels;
    });
    await board.refresh();
    expect(board.snapshot().cards[0]).toMatchObject({
      stage: "done",
      managedLabels: ["task:done"],
    });
  } finally {
    board.dispose();
  }
});
it("skips the conversation re-read for preference-only settings saves", async () => {
  const { board, host, inventory } = fixture();
  inventory.workspaces.push(workspace("w", "Task", ["task:todo"]));
  await board.start();
  const inventoryRead = vi.fn(host.inventory);
  host.inventory = inventoryRead;
  try {
    const view = board.snapshot();
    await board.mutate({
      action: "settings",
      revision: view.revision,
      expectedSettings: view.settings,
      settings: { ...view.settings, exclusiveStatusLabels: true },
    });
    expect(inventoryRead).not.toHaveBeenCalled();
    await board.mutate({
      action: "settings",
      revision: board.snapshot().revision,
      expectedSettings: board.snapshot().settings,
      settings: {
        ...board.snapshot().settings,
        groups: board
          .snapshot()
          .settings.groups.map((group) =>
            group.id === "todo" ? { ...group, label: "task:backlog" } : group,
          ),
      },
    });
    expect(inventoryRead).toHaveBeenCalled();
  } finally {
    board.dispose();
  }
});

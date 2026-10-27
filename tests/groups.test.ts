import { expect, it, vi } from "vitest";
import { Store } from "../server/store";
import { Workboard } from "../server/workboard";
import {
  DEFAULT_GROUPS,
  DEFAULT_LABELS,
  STAGES,
  defaultGroup,
  defaultWorkspaceGroup,
  newTask,
  orderedGroups,
  settingsSchema,
  type Group,
} from "../shared/model";
import { mutationSchema } from "../shared/rpc";
import { agentEvidence, fixture, workspace } from "./fixtures";

const custom: Group = {
  id: "blocked",
  kind: "in-progress",
  name: "等待依赖",
  label: "task:blocked",
};
const saveGroups = (board: Workboard, groups: Group[]) => {
  const current = board.snapshot();
  return board.mutate(
    mutationSchema.parse({
      action: "settings",
      revision: current.revision,
      settings: { ...current.settings, groups },
    }),
  );
};

it("persists a display-only group order without changing default inbox, todo or start targets", async () => {
  const ideas: Group = {
    id: "ideas",
    kind: "todo",
    name: "Ideas",
    label: "task:ideas",
  };
  const { board, backing, host, now } = fixture({
    settings: settingsSchema.parse({
      groups: [...DEFAULT_GROUPS, ideas, custom],
    }),
  });
  let reopened: Workboard | undefined;
  await board.start();
  try {
    const before = board.snapshot();
    const order = [
      custom.id,
      ideas.id,
      ...DEFAULT_GROUPS.map((group) => group.id),
    ];
    const reordered = await board.mutate(
      mutationSchema.parse({
        action: "reorder-groups",
        expectedGroupOrder: orderedGroups(before.settings).map(
          (group) => group.id,
        ),
        groupOrder: order,
      }),
    );
    expect(orderedGroups(reordered.settings).map((group) => group.id)).toEqual(
      order,
    );
    expect(defaultGroup(reordered.settings.groups)).toBe("todo");
    expect(defaultWorkspaceGroup(reordered.settings.groups)).toBe("inbox");
    const later: Group = {
      id: "later",
      kind: "review",
      name: "Later",
      label: "task:later",
    };
    const withAddedGroup = await saveGroups(board, [
      ...reordered.settings.groups,
      later,
    ]);
    expect(
      orderedGroups(withAddedGroup.settings).map((group) => group.id),
    ).toEqual([...order, later.id]);
    const withRemovedGroup = await saveGroups(
      board,
      withAddedGroup.settings.groups.filter((group) => group.id !== ideas.id),
    );
    const persistedOrder = [
      custom.id,
      ...DEFAULT_GROUPS.map((group) => group.id),
      later.id,
    ];
    expect(
      orderedGroups(withRemovedGroup.settings).map((group) => group.id),
    ).toEqual(persistedOrder);
    const draft = await board.mutate({
      action: "create",
      title: "Start target",
      description: "",
      projectId: null,
    });
    const task = draft.cards.find((card) => card.workspaceId === null)!;
    const bound = await board.mutate({
      action: "start",
      taskId: task.id,
      target: { kind: "new", source: { kind: "directory", path: "/fixture" } },
    });
    expect(bound.cards.find((card) => card.id === task.id)?.stage).toBe(
      "in-progress",
    );
    board.dispose();
    reopened = new Workboard(host, new Store(backing), now);
    await reopened.start();
    expect(
      orderedGroups(reopened.snapshot().settings).map((group) => group.id),
    ).toEqual(persistedOrder);
  } finally {
    board.dispose();
    reopened?.dispose();
  }
});

it("rejects stale or incomplete group order updates without changing the current order", async () => {
  const { board } = fixture();
  await board.start();
  try {
    const before = board.snapshot();
    const expected = orderedGroups(before.settings).map((group) => group.id);
    const order = [...expected].reverse();
    await board.mutate(
      mutationSchema.parse({
        action: "reorder-groups",
        expectedGroupOrder: expected,
        groupOrder: order,
      }),
    );
    await expect(
      board.mutate(
        mutationSchema.parse({
          action: "reorder-groups",
          expectedGroupOrder: expected,
          groupOrder: expected,
        }),
      ),
    ).rejects.toThrow("Group order changed");
    await expect(
      board.mutate(
        mutationSchema.parse({
          action: "reorder-groups",
          expectedGroupOrder: order,
          groupOrder: order.slice(1),
        }),
      ),
    ).rejects.toThrow("Group order is invalid");
    await expect(
      board.mutate(
        mutationSchema.parse({
          action: "reorder-groups",
          expectedGroupOrder: order,
          groupOrder: [...order.slice(1), "unknown-group"],
        }),
      ),
    ).rejects.toThrow("Group order is invalid");
    expect(
      orderedGroups(board.snapshot().settings).map((group) => group.id),
    ).toEqual(order);
  } finally {
    board.dispose();
  }
});

it("saves a group after background task updates without treating them as settings conflicts", async () => {
  const { board, inventory } = fixture();
  inventory.workspaces.push(workspace("w", "Before"));
  await board.start();
  try {
    const opened = board.snapshot();
    inventory.workspaces[0].name = "Updated while editing";
    await board.refresh();
    expect(board.snapshot().revision).toBeGreaterThan(opened.revision);
    const saved = await board.mutate(
      mutationSchema.parse({
        action: "settings",
        revision: opened.revision,
        expectedSettings: opened.settings,
        settings: {
          ...opened.settings,
          groups: [...opened.settings.groups, custom],
        },
      }),
    );
    expect(saved.settings.groups).toContainEqual(custom);
    expect(saved.cards[0].title).toBe("Updated while editing");
  } finally {
    board.dispose();
  }
});

it("rejects settings edited in another window even when the task revision is current", async () => {
  const { board } = fixture();
  await board.start();
  try {
    const opened = board.snapshot();
    await saveGroups(board, [...opened.settings.groups, custom]);
    const current = board.snapshot();
    await expect(
      board.mutate(
        mutationSchema.parse({
          action: "settings",
          revision: current.revision,
          expectedSettings: opened.settings,
          settings: {
            ...opened.settings,
            archiveDoneEnabled: true,
            archiveCanceledEnabled: true,
          },
        }),
      ),
    ).rejects.toThrow("Settings changed");
    expect(board.snapshot().settings).toEqual(current.settings);
  } finally {
    board.dispose();
  }
});

it("adds and renames a group without rewriting labels, then moves tasks through its native label", async () => {
  const { board, host, inventory } = fixture();
  inventory.workspaces.push(workspace("w", "Task", ["customer", "task:todo"]));
  await board.start();
  try {
    const before = board.snapshot();
    const groups = [
      ...STAGES.map((kind) => ({
        id: kind,
        kind,
        name: null,
        label: DEFAULT_LABELS[kind],
      })),
      {
        id: "blocked",
        kind: "in-progress" as const,
        name: "阻塞中",
        label: "task:blocked",
      },
    ];
    const added = await board.mutate(
      mutationSchema.parse({
        action: "settings",
        revision: before.revision,
        settings: { ...before.settings, groups },
      }),
    );
    expect(added.settings.groups).toEqual(groups);
    expect(host.setLabel).not.toHaveBeenCalled();
    const renamed = await board.mutate(
      mutationSchema.parse({
        action: "settings",
        revision: added.revision,
        settings: {
          ...added.settings,
          groups: groups.map((group) =>
            group.id === "blocked" ? { ...group, name: "等待依赖" } : group,
          ),
        },
      }),
    );
    expect(renamed.settings.groups.at(-1)?.name).toBe("等待依赖");
    expect(host.setLabel).not.toHaveBeenCalled();
    const moved = await board.mutate(
      mutationSchema.parse({
        action: "stage",
        taskId: added.cards[0].id,
        stage: "blocked",
        expectedLabels: ["task:todo"],
      }),
    );
    expect(moved.cards[0].stage).toBe("blocked");
    expect(moved.cards[0].labels.sort()).toEqual(["customer", "task:blocked"]);
    inventory.workspaces[0].labels = ["customer", "task:review"];
    await board.refresh();
    expect(board.snapshot().cards[0].stage).toBe("review");
  } finally {
    board.dispose();
  }
});

it.each(["native", "conflict", "missing", "uncertain"])(
  "refuses to delete a nonempty group with a %s workspace",
  async (reason) => {
    const { board, host, inventory, store } = fixture({
      settings: settingsSchema.parse({ groups: [...DEFAULT_GROUPS, custom] }),
    });
    inventory.workspaces.push(
      workspace("w", "Task", [
        custom.label,
        ...(reason === "conflict" ? ["task:todo"] : []),
      ]),
    );
    await board.start();
    try {
      if (reason === "uncertain")
        await store.update((data) => {
          data.tasks[0].archived = {
            operationId: "pending-archive",
            status: "uncertain",
            kind: "automatic",
            stage: custom.id,
            group: custom,
            startedAt: "2026-09-23T00:00:00Z",
            archivedAt: null,
            lastConversationAt: null,
            detail: "Outcome unknown",
          };
        });
      if (reason === "missing" || reason === "uncertain")
        inventory.workspaces = [];
      await expect(saveGroups(board, DEFAULT_GROUPS)).rejects.toThrow(
        "group-tasks-in-use",
      );
      expect(board.snapshot().settings.groups).toContainEqual(custom);
      expect(host.setLabel).not.toHaveBeenCalled();
      expect(host.archive).not.toHaveBeenCalled();
    } finally {
      board.dispose();
    }
  },
);

it.each(["todo", "inbox"] as const)(
  "requires manually moving workspaces and drafts before deleting the default %s group",
  async (kind) => {
    const ideas: Group = {
      id: "ideas",
      kind,
      name: "想法",
      label: "task:ideas",
    };
    const { board, inventory } = fixture({
      settings: settingsSchema.parse({ groups: [...DEFAULT_GROUPS, ideas] }),
    });
    const labels = kind === "todo" ? ["task:todo"] : [];
    inventory.workspaces.push(workspace("w", "w", labels));
    await board.start();
    try {
      const withoutDefault = board
        .snapshot()
        .settings.groups.filter((group) => group.id !== kind);
      await expect(saveGroups(board, withoutDefault)).rejects.toThrow(
        kind === "todo" ? "group-tasks-in-use" : "group-default-in-use",
      );
      await board.mutate({
        action: "stage",
        taskId: board.snapshot().cards[0].id,
        stage: ideas.id,
        expectedLabels: labels,
      });
      const draft = (
        await board.mutate({
          action: "create",
          title: "Idea",
          description: "Notes",
          projectId: null,
        })
      ).cards.find((card) => !card.workspaceId)!;
      if (kind === "inbox")
        await board.mutate({
          action: "stage",
          taskId: draft.id,
          stage: "inbox",
          expectedLabels: [],
        });
      await expect(saveGroups(board, withoutDefault)).rejects.toThrow(
        "group-tasks-in-use",
      );
      await board.mutate({
        action: "stage",
        taskId: draft.id,
        stage: ideas.id,
        expectedLabels: [],
      });
      const snapshot = board.snapshot();
      await board.mutate({
        action: "settings",
        revision: snapshot.revision,
        expectedSettings: snapshot.settings,
        settings: {
          ...snapshot.settings,
          groups: withoutDefault,
          ...(kind === "todo"
            ? { defaultDraftGroup: ideas.id }
            : { defaultStartGroup: ideas.id }),
        },
      });
      const next = await board.mutate({
        action: "create",
        title: "Next idea",
        description: "",
        projectId: null,
      });
      expect(next.cards.map((card) => card.stage)).toEqual([
        "ideas",
        "ideas",
        kind === "todo" ? "ideas" : "todo",
      ]);
    } finally {
      board.dispose();
    }
  },
);

it("keeps a pending binding's target group through restart and blocks deletion or semantic changes", async () => {
  const { board, host, backing, now } = fixture({
    settings: settingsSchema.parse({ groups: [...DEFAULT_GROUPS, custom] }),
  });
  await board.start();
  const create = host.create;
  host.create = vi.fn(async () => {
    throw new Error("Create unavailable");
  });
  let reopened: Workboard | undefined;
  try {
    const draft = (
      await board.mutate({
        action: "create",
        title: "Idea",
        description: "Plan",
        projectId: null,
      })
    ).cards[0];
    await expect(
      board.mutate({
        action: "start",
        taskId: draft.id,
        stage: custom.id,
        target: {
          kind: "new",
          source: { kind: "directory", path: "/fixture" },
        },
      }),
    ).rejects.toThrow("Create unavailable");
    expect(board.snapshot().cards[0].binding?.stage).toBe(custom.id);
    for (const groups of [
      DEFAULT_GROUPS,
      [...DEFAULT_GROUPS, { ...custom, label: "task:other" }],
      [...DEFAULT_GROUPS, { ...custom, kind: "review" as const }],
    ]) {
      await expect(saveGroups(board, groups)).rejects.toThrow(
        "binding still uses this group",
      );
    }
    await saveGroups(board, [...DEFAULT_GROUPS, { ...custom, name: "处理中" }]);
    board.dispose();
    host.create = create;
    reopened = new Workboard(host, new Store(backing), now);
    await reopened.start();
    expect(reopened.snapshot().cards).toHaveLength(1);
    expect(reopened.snapshot().cards[0]).toMatchObject({
      id: draft.id,
      stage: custom.id,
      labels: [custom.label, "P2"],
      binding: null,
      description: "Plan",
    });
    expect(host.create).toHaveBeenCalledTimes(1);
  } finally {
    board.dispose();
    reopened?.dispose();
  }
});

it("deletes empty groups persistently while keeping archived group names and kinds", async () => {
  const abandoned: Group = {
    id: "abandoned",
    kind: "canceled",
    name: "不再推进",
    label: "task:abandoned",
  };
  const task = newTask("idea", "Idea", "2026-09-23T00:00:00Z", abandoned.id);
  const { board, host, backing, now } = fixture({
    settings: settingsSchema.parse({ groups: [...DEFAULT_GROUPS, abandoned] }),
    tasks: [task],
  });
  let reopened: Workboard | undefined;
  await board.start();
  try {
    await expect(saveGroups(board, DEFAULT_GROUPS)).rejects.toThrow(
      "group-tasks-in-use",
    );
    await board.mutate({ action: "archive-draft", taskId: task.id });
    await saveGroups(board, [
      ...DEFAULT_GROUPS,
      { ...abandoned, name: "移除候选" },
    ]);
    await saveGroups(board, DEFAULT_GROUPS);
    board.dispose();
    reopened = new Workboard(host, new Store(backing), now);
    await reopened.start();
    expect(reopened.snapshot().settings.groups).toEqual(DEFAULT_GROUPS);
    expect(reopened.snapshot().cards[0].archived).toMatchObject({
      stage: abandoned.id,
      group: abandoned,
      status: "archived",
    });
  } finally {
    board.dispose();
    reopened?.dispose();
  }
});

it("archives by custom group kind at the conversation boundary, independent of group ID or display name", async () => {
  const shipped: Group = {
    id: "shipped",
    kind: "done",
    name: "已交付",
    label: "task:shipped",
  };
  const groups = [
    ...DEFAULT_GROUPS.map((group) =>
      group.id === "done" ? { ...group, kind: "in-progress" as const } : group,
    ),
    shipped,
  ];
  const { host, store, inventory } = fixture({
    settings: settingsSchema.parse({
      groups,
      archiveDoneEnabled: true,
      archiveCanceledEnabled: true,
    }),
  });
  inventory.workspaces.push(
    workspace("old", "Shipped", [shipped.label]),
    workspace("working", "Done", ["task:done"]),
  );
  inventory.agents = inventory.workspaces.map((w) => ({
    id: `a-${w.id}`,
    workspaceId: w.id,
    title: null,
    updatedAt: "2026-08-01T00:00:00Z",
    lastUserMessageAt: "2026-08-01T00:00:00Z",
    activity: "idle",
  }));
  host.conversation = agentEvidence("2026-08-01T00:00:00Z");
  let clock = Date.parse("2026-08-31T00:00:00Z");
  const board = new Workboard(host, store, () => clock);
  try {
    await board.start();
    expect(host.archive).not.toHaveBeenCalled();
    clock++;
    await board.refresh();
    expect(host.archive).toHaveBeenCalledExactlyOnceWith("old");
    expect(
      board.snapshot().cards.find((card) => card.workspaceId === "old")
        ?.archived?.group,
    ).toEqual(shipped);
    expect(
      board.snapshot().cards.find((card) => card.workspaceId === "working")
        ?.archived,
    ).toBeNull();
  } finally {
    board.dispose();
  }
});

it("rejects missing groups and stale group edits before writing native labels", async () => {
  const { board, host, inventory } = fixture();
  inventory.workspaces.push(workspace("w"));
  await board.start();
  try {
    const before = board.snapshot();
    await saveGroups(board, [...DEFAULT_GROUPS, custom]);
    await expect(
      board.mutate({
        action: "settings",
        revision: before.revision,
        settings: before.settings,
      }),
    ).rejects.toThrow("Settings changed");
    await expect(
      board.mutate({
        action: "stage",
        taskId: before.cards[0].id,
        stage: "removed",
        expectedLabels: [],
      }),
    ).rejects.toThrow("Group no longer exists");
    expect(host.setLabel).not.toHaveBeenCalled();
    expect(board.snapshot().settings.groups).toContainEqual(custom);
  } finally {
    board.dispose();
  }
});

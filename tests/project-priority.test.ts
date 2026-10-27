import { expect, it, vi } from "vitest";
import { fixture, workspace } from "./fixtures";
import { Workboard } from "../server/workboard";
import { taskSections } from "../client/project-groups";
import { mutationSchema } from "../shared/rpc";
import { loadViewPreferencesFrom } from "../client/view-preferences";
import { attentionReasons, visibleCards } from "../client/board-utils";
import { newTask, priorityLabels, settingsSchema } from "../shared/model";
import { migrateData } from "../shared/migrations";

it("keeps legacy priority-named status groups usable and allows incremental repair", async () => {
  const settings = structuredClone(
    settingsSchema.parse({ archiveDoneEnabled: true }),
  );
  settings.groups.find((g) => g.id === "in-progress")!.label = "priority:high";
  settings.groups.find((g) => g.id === "review")!.label = "priority:low";
  const f = fixture(migrateData({ schemaVersion: 10, settings }, 10));
  f.inventory.workspaces.push(
    workspace("legacy", "Legacy", ["priority:high", "keep"]),
  );
  await f.board.start();
  try {
    let b = f.board.snapshot();
    expect(b.cards[0].stage).toBe("in-progress");
    const save = async (next: typeof settings) => {
      b = await f.board.mutate({
        action: "settings",
        revision: b.revision,
        expectedSettings: b.settings,
        settings: next,
      });
    };
    await save({ ...b.settings, archiveDoneEnabled: false });
    expect(b.settings.archiveDoneEnabled).toBe(false);
    expect(b.cards[0].priority ?? "p2").toBe("p2");
    const groups = b.settings.groups.map((g) =>
      g.id === "review" ? { ...g, label: "task:review" } : g,
    );
    await save({ ...b.settings, groups });
    expect(b.settings.groups.find((g) => g.id === "in-progress")!.label).toBe(
      "priority:high",
    );
    await save({
      ...b.settings,
      groups: b.settings.groups.map((g) =>
        g.id === "in-progress" ? { ...g, label: "task:in-progress" } : g,
      ),
    });
    await expect(
      save({
        ...b.settings,
        groups: b.settings.groups.map((g) =>
          g.id === "review" ? { ...g, label: "priority:low" } : g,
        ),
      }),
    ).rejects.toThrow("Priority labels are reserved");
    expect(f.inventory.workspaces[0].labels).toEqual(["priority:high", "keep"]);
  } finally {
    f.board.dispose();
  }
});

it.each([undefined, "p2", "p3"] as const)(
  "binds a %s draft without touching priority-named status labels",
  async (priority) => {
    const settings = structuredClone(settingsSchema.parse({}));
    settings.groups.find((g) => g.id === "in-progress")!.label =
      "priority:high";
    const f = fixture({
      settings,
      tasks: [
        { ...newTask("draft", "Draft", "2026-09-01T00:00:00Z"), priority },
      ],
    });
    await f.board.start();
    try {
      const b = await f.board.mutate({
        action: "start",
        taskId: "draft",
        target: {
          kind: "new",
          source: { kind: "directory", path: "/fixture" },
        },
      });
      expect(b.cards[0]).toMatchObject({ stage: "in-progress", binding: null });
      expect(b.cards[0].priority ?? "p2").toBe(priority ?? "p2");
      expect(f.inventory.workspaces[0].labels).toEqual(
        priority === "p3" ? ["priority:high", "P3"] : ["priority:high", "P2"],
      );
      const c = b.cards[0];
      await f.board.mutate({
        action: "priority",
        taskId: c.id,
        updatedAt: c.updatedAt,
        priority: "p2",
        expectedLabels: priority === "p3" ? ["P3"] : ["P2"],
      });
      expect(f.inventory.workspaces[0].labels).toEqual(["priority:high", "P2"]);
    } finally {
      f.board.dispose();
    }
  },
);

it("rejects unavailable priority before persisting a binding or creating a workspace, then binds after repair", async () => {
  const settings = structuredClone(settingsSchema.parse({}));
  settings.groups.find((g) => g.id === "review")!.label = "P1";
  const f = fixture({
    settings,
    tasks: [
      {
        ...newTask("draft", "Draft", "2026-09-01T00:00:00Z"),
        priority: "p1",
      },
    ],
  });
  await f.board.start();
  try {
    const input = {
      action: "start" as const,
      taskId: "draft",
      target: {
        kind: "new" as const,
        source: { kind: "directory" as const, path: "/fixture" },
      },
    };
    await expect(f.board.mutate(input)).rejects.toThrow(
      "Priority label is used by a status group",
    );
    expect(f.host.create).not.toHaveBeenCalled();
    expect(f.host.setLabel).not.toHaveBeenCalled();
    expect(f.store.current.tasks[0]).toMatchObject({
      binding: null,
      workspaceId: null,
      priority: "p1",
    });
    let b = f.board.snapshot();
    await f.board.mutate({
      action: "settings",
      revision: b.revision,
      expectedSettings: b.settings,
      settings: {
        ...b.settings,
        groups: b.settings.groups.map((g) =>
          g.id === "review" ? { ...g, label: "task:review" } : g,
        ),
      },
    });
    b = await f.board.mutate(input);
    expect(b.cards[0]).toMatchObject({ binding: null, priority: "p1" });
    expect(f.host.create).toHaveBeenCalledTimes(1);
  } finally {
    f.board.dispose();
  }
});

it("includes a priority-only conflict in Needs attention and excludes status-owned priority names", async () => {
  const f = fixture();
  f.inventory.workspaces.push(
    workspace("conflict", "Conflict", ["task:todo", "P1", "P3"]),
  );
  await f.board.start();
  try {
    const b = f.board.snapshot();
    expect(b.cards[0].issue).toBeNull();
    expect(attentionReasons(b.cards[0])).toEqual(["priority-labels-conflict"]);
    expect(visibleCards(b, "all", "", true).map((c) => c.id)).toEqual([
      b.cards[0].id,
    ]);
    expect(
      attentionReasons({
        ...b.cards[0],
        managedLabels: ["task:todo", "P1"],
      }),
    ).toEqual([]);
  } finally {
    f.board.dispose();
  }
});

it("keeps conflict-only projects out of lanes and counts only presented cards in mixed projects", async () => {
  const f = fixture({
    settings: settingsSchema.parse({ exclusiveStatusLabels: false }),
  });
  f.inventory.workspaces.push(
    {
      ...workspace("conflict-only", "Conflict", ["task:todo", "task:review"]),
      projectId: "only",
    },
    {
      ...workspace("mixed-conflict", "Conflict", ["task:todo", "task:review"]),
      projectId: "mixed",
    },
    { ...workspace("p2", "Normal", ["task:todo"]), projectId: "mixed" },
  );
  await f.board.start();
  try {
    const b = f.board.snapshot();
    const input = {
      cards: b.cards,
      fullCards: b.cards,
      groups: b.settings.groups,
      cardOrderByStage: b.cardOrderByStage,
      projects: b.projects,
      unassigned: "None",
    };
    const sections = taskSections(input);
    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({ id: "project:id:mixed", total: 1 });
    expect(sections[0].cards.map((c) => c.workspaceId)).toEqual(["p2"]);
    expect(
      taskSections({
        ...input,
        cards: b.cards.filter((c) => c.stage === "conflict"),
      }),
    ).toEqual([]);
    expect(b.cards.filter((c) => c.stage === "conflict")).toHaveLength(2);
  } finally {
    f.board.dispose();
  }
});

it.each(["remove-fails", "response-lost"])(
  "recovers from partially applied priority labels: %s",
  async (failure) => {
    const f = fixture();
    f.inventory.workspaces.push(
      workspace("w", "Workspace", ["task:todo", "keep", "P3"]),
    );
    await f.board.start();
    try {
      const original = f.board.snapshot().cards[0];
      const originalTask = structuredClone(f.store.current.tasks[0]);
      const real = f.host.setLabel;
      f.host.setLabel = async (id, name, color, assigned) => {
        if (failure === "remove-fails" && !assigned)
          throw new Error("remove failed");
        const labels = await real(id, name, color, assigned);
        if (failure === "response-lost") throw new Error("response lost");
        return labels;
      };
      const input = {
        action: "priority" as const,
        taskId: original.id,
        updatedAt: original.updatedAt,
        priority: "p1" as const,
        expectedLabels: ["P3"],
      };
      await expect(f.board.mutate(input)).rejects.toThrow(
        failure === "remove-fails" ? "remove failed" : "response lost",
      );
      expect(f.inventory.workspaces[0].labels).toEqual([
        "task:todo",
        "keep",
        "P3",
        "P1",
      ]);
      expect(f.store.current.tasks[0]).toMatchObject({
        ...originalTask,
        issue: "priority-sync-uncertain",
        priorityWrite: { operationId: expect.any(String), priority: "p1" },
      });
      f.host.setLabel = real;
      await expect(f.board.mutate(input)).rejects.toThrow(
        "priority labels changed",
      );
      await f.board.refresh();
      const refreshed = f.board.snapshot().cards[0];
      expect(refreshed.priority).toBe("p1");
      expect(attentionReasons(refreshed)).toContain("priority-labels-conflict");
      await expect(f.board.mutate(input)).rejects.toThrow("Task changed");
      const result = await f.board.mutate({
        ...input,
        updatedAt: refreshed.updatedAt,
        expectedLabels: priorityLabels(refreshed.labels),
        priority: "p1",
      });
      expect(result.cards[0].priority).toBe("p1");
      expect(f.inventory.workspaces[0].labels).toEqual([
        "task:todo",
        "keep",
        "P1",
      ]);
      expect(attentionReasons(result.cards[0])).not.toContain(
        "priority-labels-conflict",
      );
    } finally {
      f.board.dispose();
    }
  },
);

it("persists priority across refresh and reload, rejects stale edits, and updates only native priority labels", async () => {
  const f = fixture();
  f.inventory.workspaces.push(
    workspace("w", "Existing", ["task:todo", "keep:label"]),
  );
  await f.board.start();
  try {
    const original = f.board.snapshot().cards[0];
    expect(original.priority).toBeUndefined();
    const input = mutationSchema.parse({
      action: "priority",
      taskId: original.id,
      updatedAt: original.updatedAt,
      priority: "p1",
      expectedLabels: [],
    });
    if (input.action !== "priority")
      throw new Error("Expected priority mutation");
    const changed = (await f.board.mutate(input)).cards[0];
    expect(changed).toMatchObject({
      priority: "p1",
      stage: original.stage,
      workspaceId: "w",
      title: original.title,
    });
    await expect(f.board.mutate({ ...input, priority: "p3" })).rejects.toThrow(
      "Task changed",
    );
    await f.board.refresh();
    expect(f.board.snapshot().cards[0].priority).toBe("p1");
    const reloaded = new Workboard(f.host, f.store, f.now);
    await reloaded.start();
    try {
      expect(reloaded.snapshot().cards[0].priority).toBe("p1");
    } finally {
      reloaded.dispose();
    }
    expect(f.inventory.workspaces[0].labels).toEqual([
      "task:todo",
      "keep:label",
      "P1",
    ]);
    expect(f.host.create).not.toHaveBeenCalled();
    expect(f.host.archive).not.toHaveBeenCalled();
    expect(
      mutationSchema.safeParse({ ...input, priority: "urgent" }).success,
    ).toBe(false);
  } finally {
    f.board.dispose();
  }
});

it("groups projects by ID, keeps statuses and stable manual order, and counts filtered cards", async () => {
  const f = fixture();
  f.inventory.workspaces.push(
    { ...workspace("a"), projectId: "p1", projectDisplayName: "Same name" },
    { ...workspace("b"), projectId: "p2", projectDisplayName: "Same name" },
    { ...workspace("c"), projectId: "p1", projectDisplayName: "Same name" },
    { ...workspace("d"), projectId: "p1", projectDisplayName: "Same name" },
  );
  await f.board.start();
  try {
    const board = f.board.snapshot();
    const cards = board.cards.map((c, i) => ({
      ...c,
      priority: (["p2", "p3", "p1", "p2"] as const)[i],
    }));
    const order = cards.map((c) => c.id);
    const base = {
      cards,
      fullCards: cards,
      groups: board.settings.groups,
      cardOrderByStage: { inbox: order },
      projects: board.projects,
      unassigned: "None",
    };
    const grouped = taskSections(base);
    expect(grouped).toHaveLength(2);
    expect(grouped[0].cards.map((c) => c.workspaceId)).toEqual(["a", "c", "d"]);
    expect(cards.map((c) => c.id)).toEqual(order);
    expect(grouped[0].cards.every((c) => c.stage === "inbox")).toBe(true);
    const filtered = taskSections({
      ...base,
      cards: cards.slice(0, 1),
    });
    expect(filtered[0].cards).toHaveLength(1);
    expect(filtered[0].total).toBe(3);
  } finally {
    f.board.dispose();
  }
});

it("remembers project grouping independently of state folds and ignores malformed preferences", () => {
  const saved = {
    mode: "list",
    groupBy: "project",
    priorityFirst: true,
    collapsedListGroups: ["todo"],
    collapsedProjectGroups: ["project:id:p", "", "project:id:p", 1],
  };
  expect(
    loadViewPreferencesFrom({ getItem: () => JSON.stringify(saved) }, "host"),
  ).toEqual({ ...saved, collapsedProjectGroups: ["project:id:p"] });
  const invalid = loadViewPreferencesFrom(
    {
      getItem: () =>
        '{"groupBy":"future","priorityFirst":"yes","collapsedProjectGroups":7}',
    },
    "host",
  );
  expect(invalid.groupBy).toBeUndefined();
  expect(invalid.priorityFirst).toBe(true);
});

it("persists custom priority names and colors with conflict checks and stable task identities", async () => {
  const { DEFAULT_PRIORITY_STYLES, settingsSchema } = await import(
    "../shared/model"
  );
  const f = fixture();
  f.inventory.workspaces.push(workspace("custom"));
  await f.board.start();
  try {
    const before = f.board.snapshot();
    const priorityStyles = {
      ...DEFAULT_PRIORITY_STYLES,
      p2: { name: "计划中", color: "violet" as const },
    };
    const input = {
      action: "settings" as const,
      revision: before.revision,
      expectedSettings: before.settings,
      settings: { ...before.settings, priorityStyles },
    };
    const after = await f.board.mutate(input);
    expect(after.settings.priorityStyles).toEqual(priorityStyles);
    expect(after.cards).toEqual(before.cards);
    expect(after.cardOrderByStage).toEqual(before.cardOrderByStage);
    await expect(f.board.mutate(input)).rejects.toThrow("Settings changed");
    const reloaded = new Workboard(f.host, f.store, f.now);
    await reloaded.start();
    try {
      expect(reloaded.snapshot().settings.priorityStyles).toEqual(
        priorityStyles,
      );
    } finally {
      reloaded.dispose();
    }
    for (const name of ["", " ", "x".repeat(25)]) {
      expect(
        settingsSchema.safeParse({
          ...input.settings,
          priorityStyles: {
            ...priorityStyles,
            p2: { name, color: "blue" },
          },
        }).success,
      ).toBe(false);
    }
    expect(
      settingsSchema.safeParse({
        ...input.settings,
        priorityStyles: {
          ...priorityStyles,
          p2: { name: "计划中", color: "unknown" },
        },
      }).success,
    ).toBe(false);
    expect(settingsSchema.parse({}).priorityStyles).toBeUndefined();
    expect(f.host.setLabel).not.toHaveBeenCalled();
    expect(f.host.archive).not.toHaveBeenCalled();
  } finally {
    f.board.dispose();
  }
});

it("tracks native priority labels in both directions without replacing status or unrelated labels", async () => {
  const f = fixture();
  const w = workspace("native", "Native", ["task:todo", "keep", "P3"]);
  f.inventory.workspaces.push(w);
  await f.board.start();
  try {
    let card = f.board.snapshot().cards[0];
    expect(card.priority).toBe("p3");
    const edit = {
      action: "priority" as const,
      taskId: card.id,
      updatedAt: card.updatedAt,
      priority: "p1" as const,
      expectedLabels: ["P3"],
    };
    w.labels = ["task:todo", "keep", "P2"];
    await expect(f.board.mutate(edit)).rejects.toThrow(
      "priority labels changed",
    );
    expect(f.host.setLabel).not.toHaveBeenCalled();
    await f.board.refresh();
    card = f.board.snapshot().cards[0];
    expect(card.priority).toBe("p2");
    expect(card.updatedAt).not.toBe(edit.updatedAt);
    await f.board.mutate({
      ...edit,
      updatedAt: card.updatedAt,
      expectedLabels: ["P2"],
    });
    expect(w.labels).toEqual(["task:todo", "keep", "P1"]);
    card = f.board.snapshot().cards[0];
    await f.board.mutate({
      ...edit,
      updatedAt: card.updatedAt,
      priority: "p2",
      expectedLabels: ["P1"],
    });
    expect(w.labels).toEqual(["task:todo", "keep", "P2"]);
    await f.board.refresh();
    expect(f.board.snapshot().cards[0].priority).toBe("p2");
    expect(f.host.archive).not.toHaveBeenCalled();
  } finally {
    f.board.dispose();
  }
});

it("retains draft priority through merge and restore without changing the survivor", async () => {
  const { newTask } = await import("../shared/model");
  for (const priority of ["p1", "p3", undefined] as const) {
    const f = fixture({
      tasks: [
        { ...newTask("draft", "Draft", "2026-09-01T00:00:00Z"), priority },
        {
          ...newTask("existing", "Existing", "2026-09-01T00:00:00Z"),
          workspaceId: "survivor",
          priority: "p3",
        },
      ],
    });
    f.inventory.workspaces.push(workspace("survivor", "Existing", ["P3"]));
    await f.board.start();
    try {
      await f.board.mutate({
        action: "start",
        taskId: "draft",
        target: { kind: "existing", workspaceId: "survivor" },
      });
      const survivor = f.board.snapshot().cards[0];
      expect(survivor.priority).toBe("p3");
      expect(survivor.mergedDrafts[0].priority).toBe(priority);
      const restored = await f.board.mutate({
        action: "detach-draft",
        taskId: survivor.id,
        updatedAt: survivor.updatedAt,
        draftId: "draft",
      });
      expect(restored.cards.find((c) => c.id === "draft")?.priority).toBe(
        priority,
      );
      expect(restored.cards.find((c) => c.id === survivor.id)?.priority).toBe(
        "p3",
      );
    } finally {
      f.board.dispose();
    }
  }
});

it("uses the current inventory name after renaming a draft-only project", async () => {
  const f = fixture();
  f.inventory.projects.push({
    id: "renamed",
    name: "Old name",
    directory: "/fixture",
    isGit: false,
  });
  await f.board.start();
  try {
    await f.board.mutate({
      action: "create",
      title: "Draft",
      description: "",
      projectId: "renamed",
    });
    f.inventory.projects[0].name = "New name";
    await f.board.refresh();
    const b = f.board.snapshot();
    expect(b.cards[0].projectName).toBe("Old name");
    const input = {
      cards: b.cards,
      fullCards: b.cards,
      groups: b.settings.groups,
      cardOrderByStage: b.cardOrderByStage,
      projects: b.projects,
      unassigned: "None",
    };
    expect(taskSections(input)[0].title).toBe("New name");
    expect(taskSections({ ...input, projects: [] })[0].title).toBe("Old name");
  } finally {
    f.board.dispose();
  }
});

it("keeps metadata unchanged after an uncertain label write and resolves conflicting native priorities explicitly", async () => {
  const f = fixture();
  f.inventory.workspaces.push(
    workspace("conflict", "Conflict", ["task:todo", "P1", "P3", "keep"]),
  );
  await f.board.start();
  try {
    const original = f.board.snapshot().cards[0];
    expect(
      original.labels.filter((name) => priorityLabels([name]).length > 0),
    ).toHaveLength(2);
    const real = f.host.setLabel;
    f.host.setLabel = async () => {
      throw new Error("offline");
    };
    const input = {
      action: "priority" as const,
      taskId: original.id,
      updatedAt: original.updatedAt,
      priority: "p3" as const,
      expectedLabels: ["P1", "P3"],
    };
    await expect(f.board.mutate(input)).rejects.toThrow("offline");
    expect(f.board.snapshot().cards[0].updatedAt).toBe(original.updatedAt);
    f.host.setLabel = real;
    const result = await f.board.mutate(input);
    expect(result.cards[0].priority).toBe("p3");
    expect(
      result.cards[0].labels.filter(
        (name) => priorityLabels([name]).length > 0,
      ),
    ).toEqual(["P3"]);
    expect(f.inventory.workspaces[0].labels).toEqual([
      "task:todo",
      "P3",
      "keep",
    ]);
  } finally {
    f.board.dispose();
  }
});

it("carries a draft's priority into its newly created workspace", async () => {
  const { newTask } = await import("../shared/model");
  const f = fixture({
    tasks: [
      {
        ...newTask("draft", "Draft", "2026-09-01T00:00:00Z"),
        priority: "p1",
      },
    ],
  });
  await f.board.start();
  try {
    const result = await f.board.mutate({
      action: "start",
      taskId: "draft",
      target: { kind: "new", source: { kind: "directory", path: "/fixture" } },
    });
    expect(result.cards[0].priority).toBe("p1");
    expect(f.inventory.workspaces[0].labels).toEqual([
      "task:in-progress",
      "P1",
    ]);
    await f.board.refresh();
    expect(f.board.snapshot().cards[0].priority).toBe("p1");
  } finally {
    f.board.dispose();
  }
});

it("materializes explicit P2 on an unlabeled import and resolves only a unique external newcomer", async () => {
  const f = fixture();
  f.inventory.workspaces.push(
    workspace("w", "Workspace", ["task:todo", "keep"]),
  );
  await f.board.start();
  try {
    expect(f.host.setLabel).not.toHaveBeenCalled();
    let card = f.board.snapshot().cards[0];
    await f.board.mutate({
      action: "priority",
      taskId: card.id,
      updatedAt: card.updatedAt,
      priority: "p2",
      expectedLabels: [],
    });
    expect(f.inventory.workspaces[0].labels).toEqual([
      "task:todo",
      "keep",
      "P2",
    ]);
    f.inventory.workspaces[0].labels.push("P0");
    await f.board.refresh();
    expect(f.inventory.workspaces[0].labels).toEqual([
      "task:todo",
      "keep",
      "P0",
    ]);
    expect(f.board.snapshot().cards[0].priority).toBe("p0");
  } finally {
    f.board.dispose();
  }
});

it("retains an uncertain own write across restart until explicit selection", async () => {
  const f = fixture();
  f.inventory.workspaces.push(
    workspace("w", "Workspace", ["task:todo", "keep", "P3"]),
  );
  await f.board.start();
  const real = f.host.setLabel;
  let writes = 0;
  f.host.setLabel = async (id, name, color, assigned) => {
    expect(f.store.current.tasks[0].priorityWrite?.priority).toBe("p0");
    writes++;
    if (!assigned) throw new Error("removal unavailable");
    return real(id, name, color, assigned);
  };
  const original = f.board.snapshot().cards[0];
  await expect(
    f.board.mutate({
      action: "priority",
      taskId: original.id,
      updatedAt: original.updatedAt,
      priority: "p0",
      expectedLabels: ["P3"],
    }),
  ).rejects.toThrow("removal unavailable");
  expect(writes).toBe(2);
  f.board.dispose();
  f.host.setLabel = real;
  const reloaded = new Workboard(f.host, f.store, f.now);
  await reloaded.start();
  try {
    await reloaded.refresh();
    const card = reloaded.snapshot().cards[0];
    expect(f.inventory.workspaces[0].labels).toEqual([
      "task:todo",
      "keep",
      "P3",
      "P0",
    ]);
    expect(card.priorityLabelBaseline).toEqual(["P3"]);
    expect(attentionReasons(card)).toContain("priority-sync-uncertain");
    const result = await reloaded.mutate({
      action: "priority",
      taskId: card.id,
      updatedAt: card.updatedAt,
      priority: "p3",
      expectedLabels: ["P3", "P0"],
    });
    expect(result.cards[0].priorityWrite).toBeNull();
    expect(f.inventory.workspaces[0].labels).toEqual([
      "task:todo",
      "keep",
      "P3",
    ]);
  } finally {
    reloaded.dispose();
  }
});

it("keeps ambiguous conflicts manual and preserves their last clean baseline", async () => {
  const f = fixture({
    settings: settingsSchema.parse({ exclusiveStatusLabels: false }),
  });
  f.inventory.workspaces.push(
    workspace("initial", "Initial", ["P0", "P1"]),
    workspace("observed", "Observed", ["P2"]),
  );
  await f.board.start();
  try {
    expect(f.host.setLabel).not.toHaveBeenCalled();
    f.inventory.workspaces[1].labels.push("P0", "P1");
    await f.board.refresh();
    expect(f.host.setLabel).not.toHaveBeenCalled();
    expect(
      f.board.snapshot().cards.find((c) => c.workspaceId === "observed")
        ?.priorityLabelBaseline,
    ).toEqual(["P2"]);
    f.inventory.workspaces[1].labels = ["P2", "P1"];
    await f.board.refresh();
    expect(f.inventory.workspaces[1].labels).toEqual(["P1"]);
    expect(f.inventory.workspaces[0].labels).toEqual(["P0", "P1"]);
    expect(f.board.snapshot().settings.exclusiveStatusLabels).toBe(false);
  } finally {
    f.board.dispose();
  }
});

it("reads legacy aliases without writes and normalizes only explicit selection", async () => {
  const f = fixture();
  f.inventory.workspaces.push(
    workspace("w", "Workspace", ["task:todo", "priority:high", "keep"]),
  );
  await f.board.start();
  try {
    const card = f.board.snapshot().cards[0];
    expect(card.priority).toBe("p1");
    expect(f.host.setLabel).not.toHaveBeenCalled();
    await f.board.mutate({
      action: "priority",
      taskId: card.id,
      updatedAt: card.updatedAt,
      priority: "p1",
      expectedLabels: ["priority:high"],
    });
    expect(f.inventory.workspaces[0].labels).toEqual([
      "task:todo",
      "keep",
      "P1",
    ]);
  } finally {
    f.board.dispose();
  }
});

it("requires actual P2 presence in final native verification", async () => {
  const f = fixture();
  f.inventory.workspaces.push(workspace("w"));
  await f.board.start();
  const real = f.host.setLabel;
  f.host.setLabel = async (...args) => {
    const labels = await real(...args);
    f.inventory.workspaces[0].labels = [];
    return labels;
  };
  try {
    const card = f.board.snapshot().cards[0];
    await expect(
      f.board.mutate({
        action: "priority",
        taskId: card.id,
        updatedAt: card.updatedAt,
        priority: "p2",
        expectedLabels: [],
      }),
    ).rejects.toThrow("could not be verified");
    expect(f.store.current.tasks[0].priorityWrite?.priority).toBe("p2");
  } finally {
    f.board.dispose();
  }
});

it("preserves the winning legacy alias during automatic exclusivity", async () => {
  const f = fixture();
  f.inventory.workspaces.push(workspace("w", "Example", ["P0", "keep"]));
  await f.board.start();
  try {
    f.inventory.workspaces[0].labels.push("priority:low");
    await f.board.refresh();
    expect(f.inventory.workspaces[0].labels).toEqual(["keep", "priority:low"]);
    expect(f.board.snapshot().cards[0].priority).toBe("p3");
  } finally {
    f.board.dispose();
  }
});

it.each(["P0", "P2"])(
  "refuses explicit %s when the native name belongs to a status group",
  async (label) => {
    const settings = settingsSchema.parse({});
    settings.groups.find((g) => g.id === "review")!.label = label;
    const f = fixture({ settings });
    f.inventory.workspaces.push(
      workspace("w", "Example", [label, "priority:high", "keep"]),
    );
    await f.board.start();
    try {
      const card = f.board.snapshot().cards[0];
      await expect(
        f.board.mutate({
          action: "priority",
          taskId: card.id,
          updatedAt: card.updatedAt,
          priority: label === "P0" ? "p0" : "p2",
          expectedLabels: ["priority:high"],
        }),
      ).rejects.toThrow("used by a status group");
      expect(f.host.setLabel).not.toHaveBeenCalled();
      expect(f.inventory.workspaces[0].labels).toEqual([
        label,
        "priority:high",
        "keep",
      ]);
    } finally {
      f.board.dispose();
    }
  },
);

it("does not resume an uncertain new-workspace priority binding on restart", async () => {
  const f = fixture({
    tasks: [
      {
        ...newTask("draft", "Example", "2026-09-01T00:00:00Z"),
        priority: "p0",
      },
    ],
  });
  await f.board.start();
  const real = f.host.setLabel;
  f.host.setLabel = async (...args) => {
    const labels = await real(...args);
    if (args[1] === "P0") throw new Error("reply lost");
    return labels;
  };
  const start = {
    action: "start" as const,
    taskId: "draft",
    target: {
      kind: "new" as const,
      source: { kind: "directory" as const, path: "/fixture" },
    },
  };
  await expect(f.board.mutate(start)).rejects.toThrow("reply lost");
  f.board.dispose();
  expect(f.store.current.tasks[0].priorityWrite?.priority).toBe("p0");
  const writes = vi.fn().mockImplementation(real);
  f.host.setLabel = writes;
  const reloaded = new Workboard(f.host, f.store, f.now);
  await reloaded.start();
  try {
    expect(writes).not.toHaveBeenCalled();
    expect(reloaded.snapshot().cards[0].binding).not.toBeNull();
    expect(reloaded.snapshot().cards[0].priorityWrite?.priority).toBe("p0");
    await reloaded.mutate(start);
    expect(reloaded.snapshot().cards[0]).toMatchObject({
      binding: null,
      priorityWrite: null,
      priority: "p0",
    });
    expect(f.host.create).toHaveBeenCalledTimes(1);
  } finally {
    reloaded.dispose();
  }
});

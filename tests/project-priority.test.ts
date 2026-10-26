import { expect, it } from "vitest";
import { fixture, workspace } from "./fixtures";
import { Workboard } from "../server/workboard";
import { taskSections } from "../client/project-groups";
import { mutationSchema } from "../shared/rpc";
import { loadViewPreferencesFrom } from "../client/view-preferences";

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
      priority: "high",
      expectedLabels: [],
    });
    if (input.action !== "priority")
      throw new Error("Expected priority mutation");
    const changed = (await f.board.mutate(input)).cards[0];
    expect(changed).toMatchObject({
      priority: "high",
      stage: original.stage,
      workspaceId: "w",
      title: original.title,
    });
    await expect(f.board.mutate({ ...input, priority: "low" })).rejects.toThrow(
      "Task changed",
    );
    await f.board.refresh();
    expect(f.board.snapshot().cards[0].priority).toBe("high");
    const reloaded = new Workboard(f.host, f.store, f.now);
    await reloaded.start();
    try {
      expect(reloaded.snapshot().cards[0].priority).toBe("high");
    } finally {
      reloaded.dispose();
    }
    expect(f.inventory.workspaces[0].labels).toEqual([
      "task:todo",
      "keep:label",
      "priority:high",
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
      priority: (["normal", "low", "high", "normal"] as const)[i],
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
  expect(invalid.priorityFirst).toBeUndefined();
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
      normal: { name: "计划中", color: "violet" as const },
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
            normal: { name, color: "blue" },
          },
        }).success,
      ).toBe(false);
    }
    expect(
      settingsSchema.safeParse({
        ...input.settings,
        priorityStyles: {
          ...priorityStyles,
          normal: { name: "计划中", color: "unknown" },
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
  const w = workspace("native", "Native", [
    "task:todo",
    "keep",
    "priority:low",
  ]);
  f.inventory.workspaces.push(w);
  await f.board.start();
  try {
    let card = f.board.snapshot().cards[0];
    expect(card.priority).toBe("low");
    const edit = {
      action: "priority" as const,
      taskId: card.id,
      updatedAt: card.updatedAt,
      priority: "high" as const,
      expectedLabels: ["priority:low"],
    };
    w.labels = ["task:todo", "keep", "priority:normal"];
    await expect(f.board.mutate(edit)).rejects.toThrow(
      "priority labels changed",
    );
    expect(f.host.setLabel).not.toHaveBeenCalled();
    await f.board.refresh();
    card = f.board.snapshot().cards[0];
    expect(card.priority).toBe("normal");
    expect(card.updatedAt).not.toBe(edit.updatedAt);
    await f.board.mutate({
      ...edit,
      updatedAt: card.updatedAt,
      expectedLabels: ["priority:normal"],
    });
    expect(w.labels).toEqual(["task:todo", "keep", "priority:high"]);
    card = f.board.snapshot().cards[0];
    await f.board.mutate({
      ...edit,
      updatedAt: card.updatedAt,
      priority: "normal",
      expectedLabels: ["priority:high"],
    });
    expect(w.labels).toEqual(["task:todo", "keep"]);
    await f.board.refresh();
    expect(f.board.snapshot().cards[0].priority).toBe("normal");
    expect(f.host.archive).not.toHaveBeenCalled();
  } finally {
    f.board.dispose();
  }
});

it("retains draft priority through merge and restore without changing the survivor", async () => {
  const { newTask } = await import("../shared/model");
  for (const priority of ["high", "low", undefined] as const) {
    const f = fixture({
      tasks: [
        { ...newTask("draft", "Draft", "2026-09-01T00:00:00Z"), priority },
        {
          ...newTask("existing", "Existing", "2026-09-01T00:00:00Z"),
          workspaceId: "survivor",
          priority: "low",
        },
      ],
    });
    f.inventory.workspaces.push(
      workspace("survivor", "Existing", ["priority:low"]),
    );
    await f.board.start();
    try {
      await f.board.mutate({
        action: "start",
        taskId: "draft",
        target: { kind: "existing", workspaceId: "survivor" },
      });
      const survivor = f.board.snapshot().cards[0];
      expect(survivor.priority).toBe("low");
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
        "low",
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
    workspace("conflict", "Conflict", [
      "task:todo",
      "priority:high",
      "priority:low",
      "keep",
    ]),
  );
  await f.board.start();
  try {
    const original = f.board.snapshot().cards[0];
    expect(
      original.labels.filter((name) => name.startsWith("priority:")),
    ).toHaveLength(2);
    const real = f.host.setLabel;
    f.host.setLabel = async () => {
      throw new Error("offline");
    };
    const input = {
      action: "priority" as const,
      taskId: original.id,
      updatedAt: original.updatedAt,
      priority: "low" as const,
      expectedLabels: ["priority:high", "priority:low"],
    };
    await expect(f.board.mutate(input)).rejects.toThrow("offline");
    expect(f.board.snapshot().cards[0].updatedAt).toBe(original.updatedAt);
    f.host.setLabel = real;
    const result = await f.board.mutate(input);
    expect(result.cards[0].priority).toBe("low");
    expect(
      result.cards[0].labels.filter((name) => name.startsWith("priority:")),
    ).toEqual(["priority:low"]);
    expect(f.inventory.workspaces[0].labels).toEqual([
      "task:todo",
      "priority:low",
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
        priority: "high",
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
    expect(result.cards[0].priority).toBe("high");
    expect(f.inventory.workspaces[0].labels).toEqual([
      "task:in-progress",
      "priority:high",
    ]);
    await f.board.refresh();
    expect(f.board.snapshot().cards[0].priority).toBe("high");
  } finally {
    f.board.dispose();
  }
});

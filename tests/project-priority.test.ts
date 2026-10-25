import { expect, it } from "vitest";
import { fixture, workspace } from "./fixtures";
import { Workboard } from "../server/workboard";
import { taskSections } from "../client/project-groups";
import { mutationSchema } from "../shared/rpc";
import { loadViewPreferencesFrom } from "../client/view-preferences";

it("persists priority across refresh and reload, rejects stale edits, and leaves native resources alone", async () => {
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
    expect(f.host.setLabel).not.toHaveBeenCalled();
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
      groupBy: "project" as const,
      unassigned: "None",
      stageTitle: (s: string) => s,
    };
    const grouped = taskSections({ ...base, priorityFirst: false });
    expect(grouped).toHaveLength(2);
    expect(grouped[0].cards.map((c) => c.workspaceId)).toEqual(["a", "c", "d"]);
    const sorted = taskSections({ ...base, priorityFirst: true });
    expect(sorted[0].cards.map((c) => c.workspaceId)).toEqual(["c", "a", "d"]);
    expect(cards.map((c) => c.id)).toEqual(order);
    expect(sorted[0].cards.every((c) => c.stage === "inbox")).toBe(true);
    const filtered = taskSections({
      ...base,
      cards: cards.slice(0, 1),
      priorityFirst: true,
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

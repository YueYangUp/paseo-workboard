import { expect, it, vi } from "vitest";
import {
  DATA_SCHEMA_VERSION,
  DEFAULT_GROUPS,
  archiveDueAt,
  newTask,
  settingsSchema,
} from "../shared/model";
import { migrateData } from "../shared/migrations";
import { agentEvidence, fixture, workspace } from "./fixtures";

it("uses the configured archive delay, with bounded integer settings and a strict boundary", async () => {
  expect(settingsSchema.parse({}).archiveAfterDays).toBe(30);
  for (const archiveAfterDays of [0, 366, 1.5])
    expect(settingsSchema.safeParse({ archiveAfterDays }).success).toBe(false);
  for (const field of [
    "archiveCanceledAfterDays",
    "archiveDoneAfterDays",
  ] as const)
    for (const days of [0, 366, 1.5])
      expect(settingsSchema.safeParse({ [field]: days }).success).toBe(false);
  expect(archiveDueAt("2026-09-20T00:00:00Z", 2)).toBe(
    "2026-09-22T00:00:00.000Z",
  );
  for (const days of [2, 3]) {
    const test = fixture({
      settings: settingsSchema.parse({
        archiveDoneEnabled: true,
        archiveCanceledEnabled: true,
        archiveAfterDays: days,
      }),
    });
    test.inventory.workspaces.push(workspace("w", "Task", ["task:done"]));
    test.inventory.agents.push({
      id: "a",
      workspaceId: "w",
      title: null,
      activity: "idle",
      updatedAt: "2026-09-20T00:00:00Z",
      lastUserMessageAt: "2026-09-20T00:00:00Z",
    });
    test.host.conversation = agentEvidence("2026-09-20T00:00:00Z");
    try {
      await test.board.start();
      expect(test.host.archive).toHaveBeenCalledTimes(days === 2 ? 1 : 0);
    } finally {
      test.board.dispose();
    }
  }
});

it.each([
  {
    name: "Canceled only",
    settings: {
      archiveCanceledAfterDays: 2,
      archiveDoneAfterDays: 4,
    },
    expected: "canceled",
  },
  {
    name: "Done only",
    settings: {
      archiveCanceledEnabled: false,
      archiveDoneAfterDays: 2,
    },
    expected: "done",
  },
] as const)(
  "applies independent terminal archive rules: $name",
  async ({ settings, expected }) => {
    const test = fixture({
      settings: settingsSchema.parse({
        archiveCanceledEnabled: true,
        archiveDoneEnabled: true,
        ...settings,
      }),
    });
    for (const stage of ["canceled", "done"] as const) {
      test.inventory.workspaces.push(
        workspace(stage, stage, [`task:${stage}`]),
      );
      test.inventory.agents.push({
        id: `agent-${stage}`,
        workspaceId: stage,
        title: null,
        activity: "idle",
        updatedAt: "2026-09-20T00:00:00Z",
        lastUserMessageAt: "2026-09-20T00:00:00Z",
      });
    }
    test.host.conversation = agentEvidence("2026-09-20T00:00:00Z");
    try {
      await test.board.start();
      expect(test.host.archive).toHaveBeenCalledExactlyOnceWith(expected);
      if (expected === "done")
        expect(
          test.board
            .snapshot()
            .cards.find((card) => card.workspaceId === "canceled")?.dueAt,
        ).toBeNull();
    } finally {
      test.board.dispose();
    }
  },
);

it("routes new drafts and unlabeled workspaces through explicit defaults and falls back for removed ids", async () => {
  const groups = [
    ...DEFAULT_GROUPS,
    { id: "ideas", kind: "todo" as const, name: "Ideas", label: "task:ideas" },
    {
      id: "incoming",
      kind: "inbox" as const,
      name: "Incoming",
      label: "task:incoming",
    },
  ];
  for (const valid of [true, false]) {
    const test = fixture({
      settings: settingsSchema.parse({
        groups,
        defaultDraftGroup: valid ? "ideas" : "removed",
        defaultStartGroup: valid ? "incoming" : "removed",
      }),
    });
    test.inventory.workspaces.push(
      workspace("w"),
      workspace("explicit", "Explicit", ["task:done"]),
    );
    try {
      await test.board.start();
      expect(test.board.snapshot().cards[0].stage).toBe(
        valid ? "incoming" : "inbox",
      );
      expect(
        test.board
          .snapshot()
          .cards.find((card) => card.workspaceId === "explicit")?.stage,
      ).toBe("done");
      const result = await test.board.mutate({
        action: "create",
        title: "Draft",
        description: "",
        projectId: null,
      });
      expect(result.cards.find((c) => !c.workspaceId)?.stage).toBe(
        valid ? "ideas" : "todo",
      );
    } finally {
      test.board.dispose();
    }
  }
});

it("requires a canceled group and restores an archived draft using archive concurrency guards", async () => {
  expect(
    settingsSchema.safeParse({
      groups: DEFAULT_GROUPS.filter((g) => g.kind !== "canceled"),
    }).success,
  ).toBe(false);
  const test = fixture({
    tasks: [
      {
        ...newTask("d", "Draft", "2026-09-01T00:00:00Z", "canceled"),
        description: "Notes",
      },
    ],
  });
  try {
    await test.board.start();
    const card = (
      await test.board.mutate({ action: "archive-draft", taskId: "d" })
    ).cards[0];
    const input = {
      action: "resolve-archive" as const,
      taskId: "d",
      operationId: card.archived!.operationId,
      updatedAt: card.updatedAt,
      outcome: "restore" as const,
    };
    await expect(
      test.board.mutate({ ...input, operationId: "stale" }),
    ).rejects.toThrow("archive-resolution-stale");
    await expect(
      test.board.mutate({ ...input, updatedAt: "stale" }),
    ).rejects.toThrow("archive-resolution-stale");
    expect((await test.board.mutate(input)).cards[0]).toMatchObject({
      archived: null,
      workspaceId: null,
      stage: "canceled",
      description: "Notes",
      issue: null,
    });
    await expect(test.board.mutate(input)).rejects.toThrow(
      "archive-resolution-stale",
    );
    expect(test.host.archive).not.toHaveBeenCalled();
  } finally {
    test.board.dispose();
  }
});

it("distinguishes occupied tasks from a default landing group and releases it by changing the default", async () => {
  const groups = [
    ...DEFAULT_GROUPS,
    {
      id: "incoming",
      kind: "inbox" as const,
      name: "Incoming",
      label: "task:incoming",
    },
  ];
  const test = fixture({ settings: settingsSchema.parse({ groups }) });
  const save = (settings: typeof test.store.current.settings) =>
    test.board.mutate({
      action: "settings",
      revision: test.store.current.revision,
      expectedSettings: test.store.current.settings,
      settings,
    });
  try {
    await test.board.start();
    await expect(
      save({
        ...test.store.current.settings,
        groups: groups.filter((g) => g.id !== "inbox"),
      }),
    ).rejects.toThrow("group-default-in-use");
    test.inventory.workspaces.push(workspace("w", "Task", ["task:inbox"]));
    await test.board.refresh();
    await expect(
      save({
        ...test.store.current.settings,
        defaultStartGroup: "incoming",
        groups: groups.filter((g) => g.id !== "inbox"),
      }),
    ).rejects.toThrow("group-tasks-in-use");
    await test.board.mutate({
      action: "stage",
      taskId: test.board.snapshot().cards[0].id,
      stage: "incoming",
      expectedLabels: ["task:inbox"],
    });
    await save({
      ...test.store.current.settings,
      defaultStartGroup: "incoming",
      groups: groups.filter((g) => g.id !== "inbox"),
    });
    expect(
      test.store.current.settings.groups.some((g) => g.id === "inbox"),
    ).toBe(false);
  } finally {
    test.board.dispose();
  }
});

it("cleans polluted v6 evidence, initializes current fields and permits real observation to establish a gate", async () => {
  const migrated = migrateData(
    {
      schemaVersion: 6,
      settings: { autoArchive: false },
      tasks: [
        {
          ...newTask("t", "Task", "2026-08-01T00:00:00Z"),
          workspaceId: "w",
          conversationAgents: [
            { id: "vanished", lastObservedAt: null, seenWhileLive: false },
          ],
        },
      ],
    },
    6,
  );
  expect(migrated.schemaVersion).toBe(DATA_SCHEMA_VERSION);
  expect(migrated.settings).toMatchObject({
    archiveAfterDays: 30,
    defaultDraftGroup: null,
    defaultStartGroup: null,
  });
  expect(migrated.tasks[0]).toMatchObject({
    conversationAgents: [],
    mergedDrafts: [],
  });
  const test = fixture(migrated);
  test.inventory.workspaces.push(workspace("w", "Task", ["task:done"]));
  test.inventory.agents.push({
    id: "real",
    workspaceId: "w",
    title: null,
    activity: "idle",
    updatedAt: "2026-08-01T00:00:00Z",
    lastUserMessageAt: "2026-08-01T00:00:00Z",
  });
  test.host.conversation = agentEvidence("2026-08-01T00:00:00Z");
  try {
    await test.board.start();
    expect(test.store.current.tasks[0].conversationGateEvidence).toBe("exact");
    expect(test.store.current.tasks[0].conversationGateAt).toBe(
      "2026-08-01T00:00:00.000Z",
    );
  } finally {
    test.board.dispose();
  }
});

it("refuses to restore an archived draft into a deleted group, retaining its notes and archive", async () => {
  const test = fixture({
    tasks: [
      {
        ...newTask("d", "Draft", "2026-09-01T00:00:00Z", "removed"),
        description: "Notes",
        archived: {
          operationId: "archive",
          kind: "draft",
          status: "archived",
          stage: "removed",
          group: null,
          startedAt: "2026-09-01T00:00:00Z",
          archivedAt: "2026-09-01T00:00:00Z",
          lastConversationAt: null,
          detail: "Archived draft",
        },
      },
    ],
  });
  try {
    await test.board.start();
    const task = test.store.current.tasks[0];
    await expect(
      test.board.mutate({
        action: "resolve-archive",
        taskId: task.id,
        operationId: "archive",
        updatedAt: task.updatedAt,
        outcome: "restore",
      }),
    ).rejects.toThrow("archive-group-unavailable");
    expect(test.store.current.tasks[0]).toMatchObject({
      archived: task.archived,
      description: "Notes",
    });
  } finally {
    test.board.dispose();
  }
});

it("protects explicit workspace and draft defaults even when they contain no tasks", async () => {
  for (const role of ["workspace", "draft"] as const) {
    const group = {
      id: "custom",
      kind: role === "draft" ? ("todo" as const) : ("review" as const),
      name: "Custom",
      label: "task:custom",
    };
    const test = fixture({
      settings: settingsSchema.parse({
        groups: [...DEFAULT_GROUPS, group],
        ...(role === "draft"
          ? { defaultDraftGroup: "custom" }
          : { defaultStartGroup: "custom" }),
      }),
    });
    try {
      await test.board.start();
      const snapshot = test.board.snapshot();
      await expect(
        test.board.mutate({
          action: "settings",
          revision: snapshot.revision,
          expectedSettings: snapshot.settings,
          settings: { ...snapshot.settings, groups: DEFAULT_GROUPS },
        }),
      ).rejects.toThrow("group-default-in-use");
      expect(test.store.current.settings.groups).toContainEqual(group);
    } finally {
      test.board.dispose();
    }
  }
});

it("retains an archived draft when the original group no longer accepts drafts", async () => {
  const groups = [
    ...DEFAULT_GROUPS,
    {
      id: "former-canceled",
      kind: "review" as const,
      name: "Review",
      label: "task:former-canceled",
    },
  ];
  const test = fixture({
    settings: settingsSchema.parse({ groups }),
    tasks: [
      {
        ...newTask("d", "Draft", "2026-09-01T00:00:00Z", "former-canceled"),
        archived: {
          operationId: "archive",
          kind: "draft",
          status: "archived",
          stage: "former-canceled",
          group: null,
          startedAt: "2026-09-01T00:00:00Z",
          archivedAt: "2026-09-01T00:00:00Z",
          lastConversationAt: null,
          detail: "Archived",
        },
      },
    ],
  });
  try {
    await test.board.start();
    await expect(
      test.board.mutate({
        action: "resolve-archive",
        taskId: "d",
        operationId: "archive",
        updatedAt: test.store.current.tasks[0].updatedAt,
        outcome: "restore",
      }),
    ).rejects.toThrow("archive-draft-group-unavailable");
    expect(test.store.current.tasks[0].archived?.operationId).toBe("archive");
  } finally {
    test.board.dispose();
  }
});

it.each([
  ["working-two", "working-two"],
  [null, "in-progress"],
  ["deleted", "in-progress"],
  ["done", "in-progress"],
] as const)(
  "F05-R01 starts directly in configured/fallback group %s without changing unlabeled import",
  async (configured, expected) => {
    const test = fixture({
      settings: settingsSchema.parse({
        defaultStartWorkGroup: configured,
        defaultStartGroup: "review",
        groups: [
          ...DEFAULT_GROUPS,
          {
            id: "working-two",
            kind: "in-progress",
            name: "Second",
            label: "task:working-two",
          },
        ],
      }),
      tasks: [newTask("draft", "Draft", "2026-09-01T00:00:00Z")],
    });
    test.inventory.workspaces.push(workspace("unlabeled"));
    await test.board.start();
    try {
      expect(
        test.board
          .snapshot()
          .cards.find((card) => card.workspaceId === "unlabeled")?.stage,
      ).toBe("review");
      const result = await test.board.mutate({
        action: "start",
        taskId: "draft",
        target: {
          kind: "new",
          source: { kind: "directory", path: "/fixture/new" },
        },
      });
      expect(result.cards.find((card) => card.id === "draft")?.stage).toBe(
        expected,
      );
      expect(result.settings.defaultStartGroup).toBe("review");
      expect(
        test.inventory.workspaces.find((w) => w.id === "unlabeled")!.labels,
      ).toEqual([]);
    } finally {
      test.board.dispose();
    }
  },
);
it("F05-R01 rejects default start without any In progress group but retains explicit stage priority", async () => {
  const test = fixture({
    settings: settingsSchema.parse({
      groups: DEFAULT_GROUPS.filter((g) => g.kind !== "in-progress"),
    }),
    tasks: [newTask("draft", "Draft", "2026-09-01T00:00:00Z")],
  });
  await test.board.start();
  const input = {
    action: "start" as const,
    taskId: "draft",
    target: {
      kind: "new" as const,
      source: { kind: "directory" as const, path: "/fixture/new" },
    },
  };
  try {
    await expect(test.board.mutate(input)).rejects.toThrow(
      "Add an In progress group before starting work",
    );
    expect(test.host.create).not.toHaveBeenCalled();
    const result = await test.board.mutate({ ...input, stage: "review" });
    expect(result.cards[0].stage).toBe("review");
  } finally {
    test.board.dispose();
  }
});
it("F05-R01 retains pending binding and explicit stages before the configured default", async () => {
  const test = fixture({
    settings: settingsSchema.parse({ defaultStartWorkGroup: "in-progress" }),
    tasks: [newTask("draft", "Draft", "2026-09-01T00:00:00Z")],
  });
  await test.board.start();
  const input = {
    action: "start" as const,
    taskId: "draft",
    target: {
      kind: "new" as const,
      source: { kind: "directory" as const, path: "/fixture/new" },
    },
  };
  try {
    vi.mocked(test.host.create).mockRejectedValueOnce(
      new Error("fixture failure"),
    );
    await expect(
      test.board.mutate({ ...input, stage: "review" }),
    ).rejects.toThrow("fixture failure");
    const binding = test.store.current.tasks[0].binding;
    expect(binding?.stage).toBe("review");
    await expect(
      test.board.mutate({ ...input, stage: "done" }),
    ).rejects.toThrow(
      "A previous binding is pending; retry its original target",
    );
    expect(test.store.current.tasks[0].binding).toEqual(binding);
    const result = await test.board.mutate(input);
    expect(result.cards[0].stage).toBe("review");
    expect(result.cards[0].binding).toBeNull();
  } finally {
    test.board.dispose();
  }
});
it.each(["done", "removed"])(
  "F05-R01 refuses an invalid new start-work default %s without making stored data unparseable",
  async (defaultStartWorkGroup) => {
    const settings = settingsSchema.parse({});
    const test = fixture({ settings });
    await test.board.start();
    try {
      expect(
        settingsSchema.safeParse({ ...settings, defaultStartWorkGroup })
          .success,
      ).toBe(true);
      await expect(
        test.board.mutate({
          action: "settings",
          revision: test.store.current.revision,
          expectedSettings: settings,
          settings: settingsSchema.parse({
            ...settings,
            defaultStartWorkGroup,
          }),
        }),
      ).rejects.toThrow("group-default-start-work-invalid");
      expect(test.store.current.settings).toEqual(settings);
    } finally {
      test.board.dispose();
    }
  },
);
it("F05-R01 requires changing the selected start-work default before changing its type", async () => {
  const settings = settingsSchema.parse({
    defaultStartWorkGroup: "in-progress",
  });
  const test = fixture({ settings });
  await test.board.start();
  try {
    const groups = settings.groups.map((g) =>
      g.id === "in-progress" ? { ...g, kind: "done" as const } : g,
    );
    await expect(
      test.board.mutate({
        action: "settings",
        revision: test.store.current.revision,
        expectedSettings: settings,
        settings: { ...settings, groups },
      }),
    ).rejects.toThrow("group-default-in-use");
    expect(test.store.current.settings).toEqual(settings);
    const result = await test.board.mutate({
      action: "settings",
      revision: test.store.current.revision,
      expectedSettings: settings,
      settings: settingsSchema.parse({
        ...settings,
        groups,
        defaultStartWorkGroup: null,
      }),
    });
    expect(
      result.settings.groups.find((g) => g.id === "in-progress")?.kind,
    ).toBe("done");
  } finally {
    test.board.dispose();
  }
});
it.each([1, 2, 3, 4, 5, 6, 7])(
  "F05-R01 migrates v%s with an independent null start-work default",
  (version) => {
    const result = migrateData(
      { schemaVersion: version, settings: { defaultStartGroup: "review" } },
      version,
    );
    expect(result.schemaVersion).toBe(DATA_SCHEMA_VERSION);
    expect(result.settings.defaultStartWorkGroup).toBeNull();
    if (version === 7) expect(result.settings.defaultStartGroup).toBe("review");
  },
);

it("F05-R01 client and server protect a selected empty working default until it is changed", async () => {
  const { groupDeleteReason } = await import("../client/board-utils");
  const settings = settingsSchema.parse({
    defaultStartWorkGroup: "working-two",
    groups: [
      ...DEFAULT_GROUPS,
      {
        id: "working-two",
        kind: "in-progress",
        name: "Second",
        label: "task:working-two",
      },
    ],
  });
  const selected = settings.groups.find((g) => g.id === "working-two")!;
  const test = fixture({ settings });
  await test.board.start();
  try {
    expect(groupDeleteReason([], settings.groups, selected, settings)).toBe(
      "groupDefaultInUse",
    );
    const groups = settings.groups.filter((g) => g.id !== selected.id);
    await expect(
      test.board.mutate({
        action: "settings",
        revision: test.store.current.revision,
        expectedSettings: settings,
        settings: { ...settings, groups },
      }),
    ).rejects.toThrow("group-default-in-use");
    expect(test.store.current.settings).toEqual(settings);
    const changed = { ...settings, defaultStartWorkGroup: "in-progress" };
    expect(
      groupDeleteReason([], settings.groups, selected, changed),
    ).toBeNull();
    await test.board.mutate({
      action: "settings",
      revision: test.store.current.revision,
      expectedSettings: settings,
      settings: changed,
    });
    const result = await test.board.mutate({
      action: "settings",
      revision: test.store.current.revision,
      expectedSettings: changed,
      settings: { ...changed, groups },
    });
    expect(result.settings.defaultStartWorkGroup).toBe("in-progress");
    expect(result.settings.groups.some((g) => g.id === selected.id)).toBe(
      false,
    );
  } finally {
    test.board.dispose();
  }
});

it("F05-R01 keeps task occupancy ahead of default occupancy on both deletion paths", async () => {
  const { groupDeleteReason } = await import("../client/board-utils");
  const settings = settingsSchema.parse({
    defaultStartWorkGroup: "in-progress",
  });
  const test = fixture({ settings });
  test.inventory.workspaces.push(
    workspace("w", "Workspace", ["task:in-progress"]),
  );
  await test.board.start();
  try {
    const selected = settings.groups.find((g) => g.id === "in-progress")!;
    expect(
      groupDeleteReason(
        test.board.snapshot().cards,
        settings.groups,
        selected,
        settings,
      ),
    ).toBe("groupDeleteNotEmpty");
    await expect(
      test.board.mutate({
        action: "settings",
        revision: test.store.current.revision,
        expectedSettings: settings,
        settings: {
          ...settings,
          groups: settings.groups.filter((g) => g.id !== selected.id),
        },
      }),
    ).rejects.toThrow("group-tasks-in-use");
    expect(test.store.current.settings).toEqual(settings);
  } finally {
    test.board.dispose();
  }
});

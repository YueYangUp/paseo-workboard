import { execFile } from "node:child_process";
import { mkdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test, type Page } from "@playwright/test";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { cardsForStage, type Board } from "../../shared/model";
import {
  DEFAULT_COLUMN_WIDTH,
  MIN_COLUMN_WIDTH,
} from "../../client/board-utils";
import { isTemporaryIntegrationHome } from "../integration/temporary-home";

const run = promisify(execFile);
const pluginId = "paseo-workboard";
const fixtureId = "workboard-fixture";
let client: DaemonClient;
let home: string;

async function snapshot(): Promise<Board> {
  return (await client.invokePluginRpc(
    pluginId,
    "workboard.snapshot",
    {},
  )) as Board;
}

async function snapshotIfReady(): Promise<Board | null> {
  try {
    return await snapshot();
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("Workboard is starting")
    )
      return null;
    throw error;
  }
}

async function openWorkboard(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByText("Workboard", { exact: true }).first().click();
  await expect(page.getByTestId("workboard-view-board")).toBeVisible();
}

async function seedOldDoneTask(): Promise<string> {
  const initial = await snapshot();
  if (
    initial.settings.archiveDoneEnabled ||
    initial.settings.archiveCanceledEnabled
  )
    await client.invokePluginRpc(pluginId, "workboard.mutate", {
      action: "settings",
      revision: initial.revision,
      expectedSettings: initial.settings,
      settings: {
        ...initial.settings,
        archiveDoneEnabled: false,
        archiveCanceledEnabled: false,
      },
    });
  const title = `UI archive candidate ${Date.now()}`;
  const directory = path.join(home, "ui-archive-candidate", String(Date.now()));
  await mkdir(directory, { recursive: true });
  const created = await client.createWorkspace({
    source: { kind: "directory", path: directory },
    title,
  });
  const workspaceId = created.workspace?.id;
  if (!workspaceId)
    throw new Error("Paseo did not create the UI fixture workspace");
  const agent = await client.createAgent({
    provider: fixtureId,
    model: "fixture-model",
    cwd: directory,
    workspaceId,
  });
  await client.refreshAgent(agent.id);
  await client.setWorkspaceLabel({
    workspaceId,
    label: { name: "task:done", color: "emerald" },
    assigned: true,
  });
  await client.reloadPlugin(pluginId);
  await expect
    .poll(
      async () => {
        const board = await snapshotIfReady();
        const card = board?.cards.find(
          (item) => item.workspaceId === workspaceId,
        );
        // An idle Agent is not read by a refresh, so the card carries its recorded activity
        // as a scheduled recheck time. Judge it by the server's clock, which the host run
        // sets ahead of real time so the fixture Agent counts as old.
        const now = Date.now() + (board?.clockOffsetMs ?? 0);
        return (
          card?.stage === "done" &&
          card.recheckAt != null &&
          Date.parse(card.recheckAt) < now - 31 * 24 * 60 * 60 * 1000
        );
      },
      { timeout: 20_000 },
    )
    .toBe(true);
  return title;
}

test.beforeAll(async () => {
  const requestedHome = process.env.WORKBOARD_INTEGRATION_HOME;
  const requestedUrl = process.env.WORKBOARD_BASE_URL;
  if (!requestedHome || !requestedUrl)
    throw new Error("Run UI tests through the isolated host runner");
  home = await realpath(requestedHome);
  if (!(await isTemporaryIntegrationHome(home)))
    throw new Error("UI tests require a system temporary integration home");
  if (
    (
      await readFile(path.join(home, ".paseo-workboard-integration"), "utf8")
    ).trim() !== "paseo-workboard-integration-v1"
  )
    throw new Error("UI tests require the integration home marker");
  const { stdout } = await run("paseo", ["status", "--home", home, "--json"], {
    encoding: "utf8",
  });
  const status = JSON.parse(stdout) as {
    home: string;
    listen: string;
    daemonVersion: string;
  };
  if (
    (await realpath(status.home)) !== home ||
    !/^127\.0\.0\.1:\d+$/.test(status.listen) ||
    requestedUrl !== `http://${status.listen}`
  )
    throw new Error("UI URL does not match the isolated loopback daemon");
  client = new DaemonClient({
    url: `ws://${status.listen}/ws`,
    clientId: `workboard-ui-${Date.now()}`,
    clientType: "cli",
    appVersion: status.daemonVersion,
  });
  await client.connect();
  const plugins = await client.listPlugins();
  for (const id of [pluginId, fixtureId])
    if (
      !plugins.some((plugin) => plugin.id === id && plugin.status === "running")
    )
      throw new Error(`Required isolated plugin is not running: ${id}`);
  await expect
    .poll(async () => (await snapshotIfReady())?.connected, {
      timeout: 20_000,
    })
    .toBe(true);
});

test.afterAll(async () => {
  await client?.close();
});

test("creates a draft through the page and displays it in Board and List", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await openWorkboard(page);
  const title = `UI draft ${Date.now()}`;
  await page
    .getByRole("button", { name: /^(New task|新建任务)$/ })
    .first()
    .click();
  await page.getByRole("textbox", { name: /^(Title|标题)$/ }).fill(title);
  await page.getByRole("button", { name: /^(Create draft|创建草稿)$/ }).click();
  let cardId = "";
  await expect
    .poll(async () => {
      cardId =
        (await snapshot()).cards.find((card) => card.title === title)?.id ?? "";
      return cardId;
    })
    .not.toBe("");
  await expect(page.getByTestId(`workboard-card-${cardId}`)).toContainText(
    title,
  );
  await page.getByTestId("workboard-view-list").click();
  await expect(page.getByTestId("workboard-view-list")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByTestId(`workboard-list-task-${cardId}`)).toContainText(
    title,
  );
  expect(pageErrors).toEqual([]);
});

test("keeps archive delays visible while disabled and Cancel leaves the rule off", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const title = await seedOldDoneTask();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await openWorkboard(page);
  await page
    .getByRole("button", { name: /^(Settings|设置)$/ })
    .last()
    .click();
  await expect(
    page.getByTestId("workboard-archive-done-delay-row"),
  ).toBeVisible();
  await expect(
    page.getByTestId("workboard-archive-canceled-delay-row"),
  ).toBeVisible();
  await expect(page.getByTestId("workboard-archive-done-days")).toBeVisible();
  await expect(
    page.getByTestId("workboard-archive-canceled-days"),
  ).toBeVisible();
  await page
    .getByRole("switch", {
      name: /^(Automatically archive Done tasks|自动归档已完成任务)$/,
    })
    .click();
  await expect(
    page.getByText(/Save automatic archive settings|保存自动归档设置/, {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByTestId("workboard-archive-candidates")).toContainText(
    title,
  );
  await page.getByRole("button", { name: /^(Cancel|取消)$/ }).click();
  await expect(
    page.getByText(/Save automatic archive settings|保存自动归档设置/, {
      exact: true,
    }),
  ).toBeHidden();
  const afterCancel = await snapshot();
  expect(afterCancel.settings.archiveDoneEnabled).toBe(false);
  expect(
    afterCancel.cards.find((card) => card.title === title)?.archived,
  ).toBeNull();
  expect(pageErrors).toEqual([]);
});

for (const width of [1440, 390]) {
  test(`project lanes and custom priorities retain default order at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.emulateMedia({ colorScheme: width === 390 ? "dark" : "light" });
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    const runId = Date.now();
    const prefix = width === 390 ? "workboard-order-" : "workboard-card-";
    const titles = [
      `Priority example A ${width} ${runId}`,
      `Priority example B ${width} ${runId}`,
    ];
    for (const title of titles)
      await client.invokePluginRpc(pluginId, "workboard.mutate", {
        action: "create",
        title,
        description: "",
        projectId: null,
      });
    let before = await snapshot();
    const ids = titles.map(
      (title) => before.cards.find((card) => card.title === title)!.id,
    );
    const stage = before.cards.find((card) => card.id === ids[0])!.stage;
    const expectedOrder = cardsForStage(
      before.cards,
      stage,
      before.cardOrderByStage,
    ).map((card) => card.id);
    await client.invokePluginRpc(pluginId, "workboard.mutate", {
      action: "reorder-cards",
      taskId: ids[0],
      stage,
      expectedOrder,
      cardOrder: expectedOrder,
    });
    before = await snapshot();
    await openWorkboard(page);
    const workboardRoute = page.url();
    await page.setViewportSize({ width, height: 1000 });
    // Older hosts remount compact navigation on resize and return to the landing page.
    // Enter the observed Workboard route after selecting the test viewport.
    await page.goto(workboardRoute);
    await page.getByTestId("workboard-view-board").click();
    await page.getByTestId("workboard-group-menu").click();
    await page
      .getByRole("radio", { name: "Group by project", exact: true })
      .click();
    const lane = page.getByTestId("workboard-project-lane-project:none");
    if (width === 390)
      await lane.getByRole("radio", { name: /^To do \(/ }).click();
    await expect(lane.getByTestId(`${prefix}${ids[0]}`)).toBeVisible();
    await page
      .getByRole("button", {
        name: `Priority: ${titles[0]} · P2`,
        exact: true,
      })
      .click();
    await page.getByRole("button", { name: "P1", exact: true }).click();
    const order = () =>
      lane
        .locator(`[data-testid^="${prefix}"]`)
        .evaluateAll((nodes) =>
          nodes.map((node) =>
            (
              node as unknown as { getAttribute(key: string): string | null }
            ).getAttribute("data-testid"),
          ),
        );
    await expect
      .poll(async () =>
        (await order()).filter((id) =>
          ids.some((value) => id === `${prefix}${value}`),
        ),
      )
      .toEqual([`${prefix}${ids[0]}`, `${prefix}${ids[1]}`]);
    await page
      .getByRole("button", { name: "Settings", exact: true })
      .last()
      .click();
    await expect(
      page.getByTestId("workboard-priority-sorting").getByRole("switch"),
    ).toHaveAttribute("aria-checked", "true");
    await page
      .getByTestId("workboard-priority-sorting")
      .getByRole("switch")
      .click();
    await page
      .getByRole("button", { name: "Back to board", exact: true })
      .click();
    const defaultIds = (await order()).filter((id) =>
      ids.some((value) => id === `${prefix}${value}`),
    );
    expect(defaultIds).toEqual(
      cardsForStage(
        before.cards,
        before.cards.find((card) => card.id === ids[0])!.stage,
        before.cardOrderByStage,
      )
        .filter((card) => ids.includes(card.id))
        .map((card) => `${prefix}${card.id}`),
    );
    expect((await snapshot()).cardOrderByStage).toEqual(
      before.cardOrderByStage,
    );
    await page
      .getByRole("button", { name: "Settings", exact: true })
      .last()
      .click();
    await page
      .getByTestId("workboard-priority-sorting")
      .getByRole("switch")
      .click();
    await page
      .getByRole("button", { name: "Back to board", exact: true })
      .click();
    await page.getByTestId("workboard-view-list").click();
    const listOrder = () =>
      page
        .locator('[data-testid^="workboard-list-task-"]')
        .evaluateAll((nodes) =>
          nodes.map((node) =>
            (
              node as unknown as { getAttribute(key: string): string | null }
            ).getAttribute("data-testid"),
          ),
        );
    await expect
      .poll(async () =>
        (await listOrder()).filter((id) =>
          ids.some((value) => id === `workboard-list-task-${value}`),
        ),
      )
      .toEqual([
        `workboard-list-task-${ids[0]}`,
        `workboard-list-task-${ids[1]}`,
      ]);
    await page
      .getByRole("button", { name: "Settings", exact: true })
      .last()
      .click();
    await page
      .getByTestId("workboard-priority-sorting")
      .getByRole("switch")
      .click();
    await page
      .getByRole("button", { name: "Back to board", exact: true })
      .click();
    await expect
      .poll(async () =>
        (await listOrder()).filter((id) =>
          ids.some((value) => id === `workboard-list-task-${value}`),
        ),
      )
      .toEqual(
        defaultIds.map((id) => id!.replace(prefix, "workboard-list-task-")),
      );
    await page.getByTestId("workboard-view-board").click();
    await page
      .getByRole("button", { name: "Settings", exact: true })
      .last()
      .click();
    await page.getByTestId("workboard-edit-priority-p1").click();
    await page
      .getByTestId("workboard-priority-name")
      .getByRole("textbox")
      .fill("Urgent");
    await page
      .getByRole("radio", { name: "Color: Violet", exact: true })
      .click();
    await page.getByTestId("workboard-save-priority").click();
    await expect(
      page.getByTestId("workboard-edit-priority-p1"),
    ).toHaveAttribute("aria-label", "Edit: P1 · Urgent");
    await page.reload();
    await page.getByTestId("workboard-view-board").click();
    if (width === 390)
      await lane.getByRole("radio", { name: /^To do \(/ }).click();
    await expect(
      page.getByRole("button", {
        name: `Priority: ${titles[0]} · P1 · Urgent`,
        exact: true,
      }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Settings", exact: true })
      .last()
      .click();
    await page.getByTestId("workboard-edit-priority-p1").click();
    await page.getByTestId("workboard-reset-priority").click();
    await page.getByTestId("workboard-save-priority").click();
    await expect(
      page.getByTestId("workboard-edit-priority-p1"),
    ).toHaveAttribute("aria-label", "Edit: P1");
    expect(
      await page.evaluate("document.documentElement.scrollWidth > innerWidth"),
    ).toBe(false);
    expect(pageErrors).toEqual([]);
  });
}

test("reorders cards after project scrolling and resizes columns with the pointer", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const stamp = Date.now();
  const prefix = `Geometry ${stamp}`;
  const projectIds: string[] = [];
  for (const name of ["Alpha", "Beta"]) {
    const directory = path.join(home, `geometry-${name}-${stamp}`);
    await mkdir(directory, { recursive: true });
    const created = await client.createWorkspace({
      source: { kind: "directory", path: directory },
      title: `${name} example workspace`,
    });
    await client.reloadPlugin(pluginId);
    await expect
      .poll(async () =>
        (await snapshotIfReady())?.cards.some(
          (c) => c.workspaceId === created.workspace!.id,
        ),
      )
      .toBe(true);
    projectIds.push(
      (await snapshot()).cards.find(
        (c) => c.workspaceId === created.workspace!.id,
      )!.projectId!,
    );
  }
  const ids: string[][] = [[], []];
  for (const [index, projectId] of projectIds.entries()) {
    for (const letter of ["a", "b", "c", "d"]) {
      const title = `${prefix} ${index} ${letter}`;
      const next = (await client.invokePluginRpc(pluginId, "workboard.mutate", {
        action: "create",
        title,
        description: "",
        projectId,
      })) as Board;
      ids[index].push(next.cards.find((c) => c.title === title)!.id);
    }
  }
  const before = await snapshot();
  const stage = before.cards.find((c) => c.id === ids[1][0])!.stage;
  const fullOrder = cardsForStage(
    before.cards,
    stage,
    before.cardOrderByStage,
  ).map((c) => c.id);
  for (const [index, members] of ids.entries())
    ids[index] = fullOrder.filter((id) => members.includes(id));
  const expectedOrder = fullOrder;
  await client.invokePluginRpc(pluginId, "workboard.mutate", {
    action: "reorder-cards",
    taskId: ids[0][0],
    stage,
    expectedOrder: fullOrder,
    cardOrder: expectedOrder,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openWorkboard(page);
  await page
    .getByRole("button", { name: "Settings", exact: true })
    .last()
    .click();
  const prioritySorting = page
    .getByTestId("workboard-priority-sorting")
    .getByRole("switch");
  await expect(prioritySorting).toHaveAttribute("aria-checked", "true");
  await prioritySorting.click();
  await expect(prioritySorting).toHaveAttribute("aria-checked", "false");
  await page
    .getByRole("button", { name: "Back to board", exact: true })
    .click();
  await page.getByPlaceholder("Search tasks or projects").fill(prefix);
  await page.getByTestId("workboard-group-menu").click();
  await page
    .getByRole("radio", { name: "Group by project", exact: true })
    .click();
  const lane = page.getByTestId(
    `workboard-project-lane-project:id:${projectIds[1]}`,
  );
  await lane.scrollIntoViewIfNeeded();
  const source = lane.getByTestId(`workboard-drag-${ids[1][0]}`);
  const target = lane.getByTestId(`workboard-card-${ids[1][2]}`);
  const start = (await source.boundingBox())!;
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    start.x + start.width / 2,
    start.y + start.height / 2 + 10,
    { steps: 3 },
  );
  // Scroll the project ancestor during the gesture, without changing column size.
  await lane.evaluate((node) => {
    type ScrollNode = {
      parentElement: ScrollNode | null;
      scrollHeight: number;
      clientHeight: number;
      scrollBy(x: number, y: number): void;
    };
    const { getComputedStyle } = globalThis as unknown as {
      getComputedStyle(node: ScrollNode): { overflowY: string };
    };
    let parent = (node as unknown as ScrollNode).parentElement;
    while (parent) {
      if (
        parent.scrollHeight > parent.clientHeight &&
        /auto|scroll/.test(getComputedStyle(parent).overflowY)
      ) {
        parent.scrollBy(0, -60);
        return;
      }
      parent = parent.parentElement;
    }
    throw new Error("Project scroll container was not found");
  });
  const destination = (await target.boundingBox())!;
  await page.mouse.move(
    destination.x + destination.width / 2,
    destination.y + destination.height - 12,
    { steps: 8 },
  );
  await page.mouse.up();
  await expect
    .poll(async () =>
      cardsForStage(
        (await snapshot()).cards,
        stage,
        (await snapshot()).cardOrderByStage,
      )
        .filter((c) => ids[1].includes(c.id))
        .map((c) => c.id),
    )
    .toEqual([ids[1][1], ids[1][2], ids[1][0], ids[1][3]]);
  const column = lane.getByTestId(`workboard-column-${stage}`);
  const initialWidth = (await column.boundingBox())!.width;
  const handle = lane.getByTestId(`workboard-resize-${stage}`);
  const rect = (await handle.boundingBox())!;
  await page.mouse.move(rect.x + rect.width / 2, rect.y + 60);
  await page.mouse.down();
  await page.mouse.move(rect.x + rect.width / 2 + 60, rect.y + 60, {
    steps: 8,
  });
  await page.mouse.up();
  await expect
    .poll(async () => Math.round((await column.boundingBox())!.width))
    .toBe(Math.round(initialWidth + 60));
  await page.reload();
  await expect(lane).toBeVisible();
  await expect
    .poll(async () => Math.round((await column.boundingBox())!.width))
    .toBe(Math.round(initialWidth + 60));
  expect(pageErrors).toEqual([]);
});

test("keeps pinned titles readable beside drag handles at default and minimum column widths", async ({
  page,
}) => {
  const stamp = Date.now();
  const ids: string[] = [];
  for (const [index, title] of [
    "Pinned example task title",
    "置顶示例任务标题",
  ].entries()) {
    const directory = path.join(home, `pinned-layout-${stamp}-${index}`);
    await mkdir(directory, { recursive: true });
    const created = await client.createWorkspace({
      source: { kind: "directory", path: directory },
      title,
    });
    const workspaceId = created.workspace!.id;
    await client.setWorkspacePinned(workspaceId, true);
    await client.setWorkspaceLabel({
      workspaceId,
      label: { name: "task:todo", color: "blue" },
      assigned: true,
    });
    ids.push(workspaceId);
  }
  await client.reloadPlugin(pluginId);
  await expect
    .poll(
      async () =>
        (await snapshotIfReady())?.cards.filter((c) =>
          ids.includes(c.workspaceId!),
        ).length,
    )
    .toBe(2);
  const cards = (await snapshot()).cards.filter((c) =>
    ids.includes(c.workspaceId!),
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openWorkboard(page);
  const column = page.getByTestId("workboard-column-todo");
  const resize = column.getByTestId("workboard-resize-todo");
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    // The keyboard reset uses the same persisted width path as the pointer control.
    await resize.press("Home");
    for (const width of [DEFAULT_COLUMN_WIDTH, MIN_COLUMN_WIDTH]) {
      if (width === MIN_COLUMN_WIDTH) {
        await resize.press("ArrowLeft");
        await resize.press("ArrowLeft");
      }
      await expect
        .poll(async () => Math.round((await column.boundingBox())!.width))
        .toBe(width);
      for (const card of cards) {
        const task = column.getByTestId(`workboard-card-${card.id}`);
        const title = task.getByRole("button", {
          name: `Open workspace: ${card.title}`,
          exact: true,
        });
        const priority = task.getByRole("button", {
          name: `Priority: ${card.title} · P2`,
          exact: true,
        });
        const pin = task.getByRole("button", {
          name: /^Paseo sidebar: existing or manual pin/,
        });
        await expect(title).toBeVisible();
        const titleBox = (await title.boundingBox())!;
        const priorityBox = (await priority.boundingBox())!;
        const pinBox = (await pin.boundingBox())!;
        const dragBox = (await column
          .getByTestId(`workboard-drag-${card.id}`)
          .boundingBox())!;
        expect(titleBox.width).toBeGreaterThanOrEqual(110);
        expect(priorityBox.y).toBeGreaterThanOrEqual(
          titleBox.y + titleBox.height - 1,
        );
        expect(pinBox.y).toBeGreaterThanOrEqual(
          titleBox.y + titleBox.height - 1,
        );
        expect(titleBox.x + titleBox.width).toBeLessThanOrEqual(dragBox.x + 1);
        expect(priorityBox.height).toBeGreaterThanOrEqual(36);
        expect(pinBox.width).toBeGreaterThanOrEqual(36);
        expect(pinBox.height).toBeGreaterThanOrEqual(36);
      }
    }
  }
});

test("opens the selected Agent conversation in its native workspace from Board and List", async ({
  page,
}, testInfo) => {
  const directory = path.join(home, `agent-navigation-${Date.now()}`);
  await mkdir(directory, { recursive: true });
  const created = await client.createWorkspace({
    source: { kind: "directory", path: directory },
    title: "Conversation navigation example",
  });
  const workspaceId = created.workspace!.id;
  const agents: string[] = [];
  for (const name of [
    "First example conversation",
    "Second example conversation",
  ]) {
    const agent = await client.createAgent({
      provider: fixtureId,
      model: "fixture-model",
      cwd: directory,
      workspaceId,
    });
    await client.sendAgentMessage(agent.id, `Conversation content: ${name}`);
    await client.updateAgent(agent.id, { name });
    agents.push(agent.id);
  }
  await client.reloadPlugin(pluginId);
  await expect
    .poll(
      async () =>
        (await snapshotIfReady())?.cards.find(
          (c) => c.workspaceId === workspaceId,
        )?.agents.length,
    )
    .toBe(2);
  const card = (await snapshot()).cards.find(
    (c) => c.workspaceId === workspaceId,
  )!;
  for (const mode of ["board", "list"] as const) {
    await openWorkboard(page);
    await page.getByTestId(`workboard-view-${mode}`).click();
    const item = page.getByTestId(
      mode === "board"
        ? `workboard-card-${card.id}`
        : `workboard-list-task-${card.id}`,
    );
    await item
      .getByRole("button", { name: "Show details", exact: true })
      .click();
    const selected = agents[mode === "board" ? 1 : 0];
    const link = item.getByTestId(`workboard-open-agent-${selected}`);
    await expect(link).toBeVisible();
    if (mode === "board") {
      await item.screenshot({ path: testInfo.outputPath("agent-links.png") });
      await link.click();
    } else {
      await link.focus();
      await link.press("Enter");
    }
    await expect(page).toHaveURL(new RegExp(`/workspace/${workspaceId}$`));
    const selectedName =
      mode === "board"
        ? "Second example conversation"
        : "First example conversation";
    const otherName =
      mode === "board"
        ? "First example conversation"
        : "Second example conversation";
    await expect(
      page.getByText(`Conversation content: ${selectedName}`, { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(`Conversation content: ${otherName}`, { exact: true }),
    ).toBeHidden();
    await page.screenshot({
      path: testInfo.outputPath(`selected-conversation-${mode}.png`),
    });
  }
});

test("explicit same-P2 selection creates the native P2 label on an imported workspace", async ({
  page,
}) => {
  const title = `P2 example ${Date.now()}`;
  const directory = path.join(home, "ui-priority-p2", String(Date.now()));
  await mkdir(directory, { recursive: true });
  const created = await client.createWorkspace({
    source: { kind: "directory", path: directory },
    title,
  });
  const workspaceId = created.workspace!.id;
  await client.reloadPlugin(pluginId);
  await expect
    .poll(async () =>
      (await snapshotIfReady())?.cards.some(
        (c) => c.workspaceId === workspaceId,
      ),
    )
    .toBe(true);
  expect(
    (await client.fetchWorkspaces()).entries.find((w) => w.id === workspaceId)
      ?.labels ?? [],
  ).toEqual([]);
  await openWorkboard(page);
  await page
    .getByRole("button", { name: `Priority: ${title} · P2`, exact: true })
    .click();
  await page.getByRole("button", { name: "P2", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await client.fetchWorkspaces()).entries.find(
          (w) => w.id === workspaceId,
        )?.labels,
    )
    .toEqual(["P2"]);
});

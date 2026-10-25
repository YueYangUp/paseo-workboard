import { execFile } from "node:child_process";
import { mkdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test, type Page } from "@playwright/test";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { cardsForStage, type Board } from "../../shared/model";
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
    await page.setViewportSize({ width, height: 1000 });
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
        name: `Priority: ${titles[0]} · Normal`,
        exact: true,
      })
      .click();
    await page.getByRole("button", { name: "High", exact: true }).click();
    await page.getByTestId("workboard-sort-menu").click();
    await page
      .getByRole("radio", { name: "Priority first", exact: true })
      .click();
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
    await page.getByTestId("workboard-sort-menu").click();
    await page
      .getByRole("radio", { name: "Default order", exact: true })
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
    await page.getByTestId("workboard-edit-priority-high").click();
    await page
      .getByTestId("workboard-priority-name")
      .getByRole("textbox")
      .fill("Urgent");
    await page
      .getByRole("radio", { name: "Color: Violet", exact: true })
      .click();
    await page.getByTestId("workboard-save-priority").click();
    await expect(
      page.getByTestId("workboard-edit-priority-high"),
    ).toHaveAttribute("aria-label", "Edit: Urgent");
    await page.reload();
    await page.getByTestId("workboard-view-board").click();
    if (width === 390)
      await lane.getByRole("radio", { name: /^To do \(/ }).click();
    await expect(
      page.getByRole("button", {
        name: `Priority: ${titles[0]} · Urgent`,
        exact: true,
      }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Settings", exact: true })
      .last()
      .click();
    await page.getByTestId("workboard-edit-priority-high").click();
    await page.getByTestId("workboard-reset-priority").click();
    await page.getByTestId("workboard-save-priority").click();
    await expect(
      page.getByTestId("workboard-edit-priority-high"),
    ).toHaveAttribute("aria-label", "Edit: High");
    expect(
      await page.evaluate("document.documentElement.scrollWidth > innerWidth"),
    ).toBe(false);
    expect(pageErrors).toEqual([]);
  });
}

import {
  cardsForStage,
  type Card,
  type CardOrderByStage,
  type Group,
} from "../shared/model";

export function sortPriorityCards(cards: readonly Card[]): Card[] {
  const rank = { high: 0, normal: 1, low: 2 };
  return [...cards].sort(
    (a, b) => rank[a.priority ?? "normal"] - rank[b.priority ?? "normal"],
  );
}

export type TaskSection = {
  id: string;
  title: string;
  cards: Card[];
  total: number;
};

/** Group by project identity, never its editable display name. Sorting leaves stored order intact. */
export function taskSections(input: {
  cards: Card[];
  fullCards: Card[];
  groups: Group[];
  cardOrderByStage: CardOrderByStage;
  groupBy: "project" | "status";
  priorityFirst: boolean;
  unassigned: string;
  stageTitle(stage: string): string;
}): TaskSection[] {
  const sections = new Map<string, TaskSection>();
  const key = (card: Card) =>
    input.groupBy === "project"
      ? card.projectId === null
        ? "project:none"
        : `project:id:${card.projectId}`
      : card.stage;
  const counts = new Map<string, number>();
  for (const card of input.fullCards) {
    if (
      card.archived?.status === "archived" ||
      card.archived?.status === "external"
    )
      continue;
    counts.set(key(card), (counts.get(key(card)) ?? 0) + 1);
  }
  const ordered = [
    ...input.groups.flatMap((group) =>
      cardsForStage(input.cards, group.id, input.cardOrderByStage),
    ),
    ...input.cards.filter((card) => card.stage === "conflict"),
  ];
  for (const card of ordered) {
    const id = key(card);
    if (!sections.has(id))
      sections.set(id, {
        id,
        title:
          input.groupBy === "project"
            ? card.projectName || input.unassigned
            : input.stageTitle(card.stage),
        cards: [],
        total: counts.get(id) ?? 0,
      });
    sections.get(id)!.cards.push(card);
  }
  const values = [...sections.values()];
  if (input.groupBy === "project")
    values.sort(
      (a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id),
    );
  if (input.priorityFirst)
    for (const section of values)
      section.cards = sortPriorityCards(section.cards);
  return values;
}

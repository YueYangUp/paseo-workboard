import {
  cardsForStage,
  type Card,
  type CardOrderByStage,
  type Group,
  type Board,
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
  projects: Board["projects"];
  unassigned: string;
}): TaskSection[] {
  const sections = new Map<string, TaskSection>();
  const key = (card: Card) =>
    card.projectId === null ? "project:none" : `project:id:${card.projectId}`;
  const projectNames = new Map(
    input.projects.map((project) => [project.id, project.name]),
  );
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
          (card.projectId !== null
            ? projectNames.get(card.projectId)
            : undefined) ||
          card.projectName ||
          input.unassigned,
        cards: [],
        total: counts.get(id) ?? 0,
      });
    sections.get(id)!.cards.push(card);
  }
  const values = [...sections.values()];
  values.sort(
    (a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id),
  );
  return values;
}

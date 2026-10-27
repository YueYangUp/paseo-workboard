import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Animated,
  Pressable,
  StyleSheet,
  Text,
  View,
  type ScrollView as NativeScrollView,
} from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import {
  Icon,
  Modal,
  ScrollView,
  useToast,
} from "@getpaseo/plugin/client/react-native";
import {
  isDraftGroup,
  type Card,
  type CardOrderByStage,
  type Group,
  type Stage,
} from "../shared/model";
import {
  cardsForStage,
  columnWidth,
  DEFAULT_COLUMN_WIDTH,
  edgeScrollSpeed,
  groupOrderAtX,
  MAX_COLUMN_WIDTH,
  MIN_COLUMN_WIDTH,
  stageAtX,
  moveCardToAnchor,
} from "./board-utils";
import { sortPriorityCards } from "./project-groups";
import { groupTitle, stageTitle, strings } from "./strings";
import {
  dragCursor,
  duringDrag,
  keyboardProps,
  loadColumnWidths,
  saveColumnWidths,
} from "./web";
import {
  loadCollapsedColumns,
  saveCollapsedColumns,
} from "./column-preferences";
import { HintButton } from "./Hint";
import { ConfirmationModal } from "./ConfirmationModal";
import { useDragHandle, type Bounds, type HandleProps } from "./drag-handle";

type Theme = PluginSurfaceProps["theme"];
const COLLAPSED_COLUMN_WIDTH = 92;
const COLUMN_GAP = 10;
const COLUMN_PADDING = 12;

type Gesture = {
  kind: "card" | "group" | "resize";
  id: string;
  rect: Bounds;
  x: number;
  y: number;
  startX: number;
  startY: number;
  card?: Card;
  order: string[];
  widths: Record<string, number>;
  expectedCardOrder: string[];
  visibleCardIds: string[];
  filterKey?: string;
};
export type BoardViewProps = {
  hostId: string;
  layoutScope?: string;
  priorityFirst?: boolean;
  cards: Card[];
  fullCards: Card[];
  cardOrderByStage: CardOrderByStage;
  filterKey?: string;
  orderPending?: ReadonlySet<string>;
  onReorderCards(
    card: Card,
    expectedOrder: string[],
    cardOrder: string[],
  ): Promise<boolean>;
  onResetCardOrder(stage: Stage, expectedOrder: string[]): Promise<boolean>;
  groups: Group[];
  compact: boolean;
  stage: Stage;
  setStage(stage: Stage): void;
  disabled: boolean;
  reordering?: boolean;
  pendingStages?: ReadonlySet<string>;
  highlightedCards?: ReadonlySet<string>;
  t: ReturnType<typeof strings>;
  theme: Theme;
  onStage(card: Card, stage: Stage): Promise<boolean>;
  onReorder(order: string[], expected: string[]): Promise<boolean>;
  onEdit(group: Group): void;
  onAdd(): void;
  onDelete(group: Group): Promise<boolean>;
  deleteReason(group: Group): string | null;
  hasActiveFilter: boolean;
  renderQuickCreate?(group: Group): ReactNode;
  quickCreateErrors?: ReadonlySet<string>;
  onClearFilters?(): void;
  onCreateTask?(): void;
  renderCard(card: Card, showDragHandle: boolean): ReactNode;
  groupColor(group: Group): string;
};

export function displayCardsForStage(
  props: Pick<BoardViewProps, "cards" | "cardOrderByStage" | "priorityFirst">,
  stage: Stage,
): Card[] {
  const cards = cardsForStage(props.cards, stage, props.cardOrderByStage);
  return props.priorityFirst ? sortPriorityCards(cards) : cards;
}

export function BoardView(props: BoardViewProps) {
  const {
    cards,
    groups,
    compact,
    stage,
    setStage,
    disabled,
    t,
    theme,
    renderCard,
  } = props;
  const toast = useToast();
  const layoutKey = props.layoutScope
    ? JSON.stringify([props.hostId, props.layoutScope])
    : props.hostId;
  const viewport = useRef<View>(null);
  const scroller = useRef<NativeScrollView>(null);
  const compactTabs = useRef<Record<string, View | null>>({});
  const bounds = useRef<Bounds>({ left: 0, top: 0, width: 0, height: 0 });
  const columns = useRef<Record<string, { left: number; right: number }>>({});
  const cardBounds = useRef<Record<string, { top: number; height: number }>>(
    {},
  );
  const lists = useRef<
    Record<
      string,
      { top: number; height: number; scrollY: number; contentHeight: number }
    >
  >({});
  const listScrollers = useRef<Record<string, NativeScrollView | null>>({});
  const listState = (stage: Stage) =>
    (lists.current[stage] ??= {
      top: 0,
      height: 0,
      scrollY: 0,
      contentHeight: 0,
    });
  const [cardInsertion, setCardInsertion] = useState<{
    stage: Stage;
    anchor: string;
    side: "before" | "after";
  } | null>(null);
  const completeOrder = (stage: Stage) =>
    cardsForStage(
      latest.current.fullCards,
      stage,
      latest.current.cardOrderByStage,
    ).map((card) => card.id);
  const contentWidth = useRef(0);
  const scrollX = useRef(0);
  const [height, setHeight] = useState(500);
  const [widths, setWidths] = useState(() => loadColumnWidths(layoutKey));
  const [collapsed, setCollapsed] = useState(
    () => new Set(loadCollapsedColumns(layoutKey)),
  );
  const widthsRef = useRef(widths);
  widthsRef.current = widths;
  const [menu, setMenu] = useState<string | null>(null);
  const [deletingGroup, setDeletingGroup] = useState<Group | null>(null);
  const [locatorOpen, setLocatorOpen] = useState(false);
  const [held, setHeld] = useState<Record<string, Card[]> | null>(null);
  const [preview, setPreview] = useState<Gesture | null>(null);
  const session = useRef<Gesture | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [insertion, setInsertion] = useState<string | null | undefined>(
    undefined,
  );
  const position = useRef(new Animated.ValueXY()).current;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cleanup = useRef<() => void>(() => {});
  const latest = useRef(props);
  latest.current = props;
  const order = groups.map((group) => group.id);
  const groupWidth = (id: string) =>
    collapsed.has(id) ? COLLAPSED_COLUMN_WIDTH : columnWidth(widths[id]);
  // Web onLayout can miss position-only changes after reorder, resize or collapse.
  let left = COLUMN_PADDING;
  columns.current = Object.fromEntries(
    groups.map((group) => {
      const bounds = { left, right: left + groupWidth(group.id) };
      left = bounds.right + COLUMN_GAP;
      return [group.id, bounds];
    }),
  );
  const groupSignature = groups
    .map((group) => `${group.id}:${group.kind}:${group.label}`)
    .join("\n");

  const persistWidth = (id: string, value: number) => {
    const next = Object.fromEntries(
      latest.current.groups.map((group) => [
        group.id,
        group.id === id
          ? columnWidth(value)
          : columnWidth(widthsRef.current[group.id]),
      ]),
    );
    widthsRef.current = next;
    setWidths(next);
    if (!saveColumnWidths(layoutKey, next)) toast.error(t.layoutSaveFailed);
  };
  const setColumnCollapsed = (id: string, value: boolean) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (value) next.add(id);
      else next.delete(id);
      if (!saveCollapsedColumns(layoutKey, [...next]))
        toast.error(t.layoutSaveFailed);
      return next;
    });
  };
  const clearGesture = () => {
    session.current = null;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    cleanup.current();
    cleanup.current = () => {};
    setHeld(null);
    setPreview(null);
    setTarget(null);
    setInsertion(undefined);
    setCardInsertion(null);
  };
  const cancel = () => {
    const current = session.current;
    if (current?.kind === "resize") {
      widthsRef.current = current.widths;
      setWidths(current.widths);
    }
    clearGesture();
  };
  const prioritySignature = props.fullCards
    .map((card) => `${card.id}:${card.priority ?? "p2"}`)
    .join("\n");
  const cancelKey = JSON.stringify([
    disabled,
    compact,
    groupSignature,
    props.filterKey,
    props.priorityFirst,
    prioritySignature,
  ]);
  useEffect(() => {
    cancel();
  }, [cancelKey]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      cleanup.current();
      session.current = null;
    },
    [],
  );

  const inside = (x: number, y: number) => {
    const view = bounds.current;
    return (
      x >= view.left &&
      x <= view.left + view.width &&
      y >= view.top &&
      y <= view.top + view.height
    );
  };
  const anchorAtY = (current: Gesture, y: number) => {
    if (!current.card || latest.current.priorityFirst) return null;
    const list = lists.current[current.card.stage];
    if (!list) return null;
    const contentY = y - list.top + list.scrollY;
    const neighbors = current.visibleCardIds.filter(
      (id) => id !== current.id && cardBounds.current[id],
    );
    const before = neighbors.find(
      (id) =>
        contentY <
        cardBounds.current[id].top + cardBounds.current[id].height / 2,
    );
    const anchor = before ?? neighbors.at(-1);
    return anchor
      ? {
          stage: current.card.stage as Stage,
          anchor,
          side: before ? ("before" as const) : ("after" as const),
        }
      : null;
  };
  const moveCardRelative = async (card: Card, direction: number) => {
    if (
      latest.current.disabled ||
      latest.current.priorityFirst ||
      latest.current.orderPending?.has(card.stage) ||
      card.binding ||
      card.archived
    )
      return;
    const visible = cardsForStage(
      latest.current.cards,
      card.stage,
      latest.current.cardOrderByStage,
    );
    const index = visible.findIndex((item) => item.id === card.id);
    const neighbor = visible[index + direction];
    if (index < 0 || !neighbor) return;
    const expected = completeOrder(card.stage);
    await latest.current.onReorderCards(
      card,
      expected,
      moveCardToAnchor(
        expected,
        card.id,
        neighbor.id,
        direction < 0 ? "before" : "after",
      ),
    );
  };
  const cardKeys = (card: Card) =>
    keyboardProps((key, event) => {
      if (!event.altKey || (key !== "ArrowUp" && key !== "ArrowDown"))
        return false;
      void moveCardRelative(card, key === "ArrowUp" ? -1 : 1);
      return true;
    });
  const updateGesture = () => {
    const current = session.current;
    if (!current) return;
    const view = bounds.current;
    if (current.kind === "resize") {
      const width = columnWidth(
        current.rect.width + current.x - current.startX,
      );
      if (widthsRef.current[current.id] !== width) {
        widthsRef.current = { ...widthsRef.current, [current.id]: width };
        setWidths(widthsRef.current);
      }
      return;
    }
    position.setValue({
      x: current.rect.left - view.left + current.x - current.startX,
      y: current.rect.top - view.top + current.y - current.startY,
    });
    const within = inside(current.x, current.y);
    const speed = within
      ? edgeScrollSpeed(current.x - view.left, view.width)
      : 0;
    const nextScroll = Math.max(
      0,
      Math.min(
        Math.max(0, contentWidth.current - view.width),
        scrollX.current + speed * 0.016,
      ),
    );
    const scrolling = nextScroll !== scrollX.current;
    if (scrolling) {
      scrollX.current = nextScroll;
      scroller.current?.scrollTo({ x: nextScroll, animated: false });
    }
    const x = current.x - view.left + scrollX.current;
    if (current.kind === "card") {
      const destination = within
        ? stageAtX(x, columns.current, current.order)
        : null;
      setTarget(destination);
      const list = current.card && lists.current[current.card.stage];
      if (list && destination === current.card?.stage) {
        const speedY = edgeScrollSpeed(current.y - list.top, list.height);
        const nextY = Math.max(
          0,
          Math.min(
            Math.max(0, list.contentHeight - list.height),
            list.scrollY + speedY * 0.016,
          ),
        );
        if (nextY !== list.scrollY) {
          list.scrollY = nextY;
          listScrollers.current[destination]?.scrollTo({
            y: nextY,
            animated: false,
          });
          queueTick();
        }
        setCardInsertion(anchorAtY(current, current.y));
      } else setCardInsertion(null);
    } else {
      if (!within) setInsertion(undefined);
      else {
        const next = groupOrderAtX(
          current.order,
          current.id,
          x,
          columns.current,
        );
        setInsertion(next[next.indexOf(current.id) + 1] ?? null);
      }
    }
    queueTick();
  };
  const tick = () => {
    timer.current = null;
    const current = session.current;
    if (current)
      measureViewport(() => {
        if (session.current === current) updateGesture();
      });
  };
  const queueTick = () => {
    if (!timer.current) timer.current = setTimeout(tick, 16);
  };
  const begin = (
    kind: Gesture["kind"],
    id: string,
    rect: Bounds,
    x: number,
    y: number,
    card?: Card,
  ) => {
    if (latest.current.disabled || session.current) return;
    const current: Gesture = {
      kind,
      id,
      rect,
      x,
      y,
      startX: x,
      startY: y,
      card,
      order: latest.current.groups.map((group) => group.id),
      widths: widthsRef.current,
      expectedCardOrder: card ? completeOrder(card.stage) : [],
      visibleCardIds: card
        ? displayCardsForStage(latest.current, card.stage).map(
            (item) => item.id,
          )
        : [],
      filterKey: latest.current.filterKey,
    };
    session.current = current;
    setHeld(
      Object.fromEntries(
        latest.current.groups.map((group) => [
          group.id,
          displayCardsForStage(latest.current, group.id),
        ]),
      ),
    );
    setPreview(current);
    position.setValue({
      x: rect.left - bounds.current.left,
      y: rect.top - bounds.current.top,
    });
    cleanup.current = duringDrag(cancel, kind === "resize");
    queueTick();
  };
  const move = (x: number, y: number) => {
    if (!session.current) return;
    session.current.x = x;
    session.current.y = y;
    queueTick();
  };
  const finishDrop = (x: number, y: number) => {
    const current = session.current;
    if (!current) return;
    if (
      latest.current.disabled ||
      current.filterKey !== latest.current.filterKey ||
      current.order.join("\n") !==
        latest.current.groups.map((group) => group.id).join("\n")
    ) {
      cancel();
      return;
    }
    clearGesture();
    if (current.kind === "resize") {
      persistWidth(current.id, current.rect.width + x - current.startX);
      return;
    }
    if (!inside(x, y)) return;
    const contentX = x - bounds.current.left + scrollX.current;
    if (current.kind === "group") {
      const next = groupOrderAtX(
        current.order,
        current.id,
        contentX,
        columns.current,
      );
      if (next.join("\n") !== current.order.join("\n"))
        void latest.current.onReorder(next, current.order);
    } else if (current.card) {
      const destination = stageAtX(contentX, columns.current, current.order);
      const live = latest.current.fullCards.find(
        (card) => card.id === current.id,
      );
      if (
        !live ||
        live.archived ||
        live.binding ||
        live.stage !== current.card.stage
      ) {
        toast.show(t.dragChanged, { variant: "warning" });
        return;
      }
      if (destination === current.card.stage) {
        if (
          latest.current.priorityFirst ||
          latest.current.orderPending?.has(destination)
        )
          return;
        const anchor = anchorAtY(current, y);
        if (anchor) {
          const next = moveCardToAnchor(
            current.expectedCardOrder,
            current.id,
            anchor.anchor,
            anchor.side,
          );
          if (next.join("\n") !== current.expectedCardOrder.join("\n"))
            void latest.current.onReorderCards(
              current.card,
              current.expectedCardOrder,
              next,
            );
        }
      } else if (destination) {
        void latest.current.onStage(current.card, destination).then((ok) => {
          if (ok) {
            setColumnCollapsed(destination, false);
          }
        });
      }
    }
  };
  const end = (x: number, y: number) => {
    const current = session.current;
    if (current)
      measureViewport(() => {
        if (session.current === current) finishDrop(x, y);
      });
  };
  // Ancestor scrolling changes window coordinates without emitting column onLayout.
  const measureViewport = (done: () => void = () => {}) => {
    const measures: Array<(next: () => void) => void> = [];
    if (viewport.current)
      measures.push((next) =>
        viewport.current!.measureInWindow((left, top, width, height) => {
          bounds.current = { left, top, width, height };
          next();
        }),
      );
    for (const [id, scroller] of Object.entries(listScrollers.current)) {
      const view = scroller?.getNativeScrollRef?.();
      if (view?.measureInWindow)
        measures.push((next) =>
          view.measureInWindow(
            (_left: number, top: number, _width: number, height: number) => {
              Object.assign(listState(id), { top, height });
              next();
            },
          ),
        );
    }
    let remaining = measures.length;
    if (!remaining) {
      done();
      return;
    }
    for (const measure of measures)
      measure(() => {
        if (--remaining === 0) done();
      });
  };
  const relativeMove = async (id: string, direction: number) => {
    const ids = latest.current.groups.map((group) => group.id);
    const index = ids.indexOf(id);
    const next = [...ids];
    const destination = index + direction;
    if (destination < 0 || destination >= ids.length) return;
    next.splice(index, 1);
    next.splice(destination, 0, id);
    await latest.current.onReorder(next, ids);
  };
  const locateGroup = (id: Stage) => {
    setLocatorOpen(false);
    if (compact) {
      setStage(id);
      return;
    }
    setColumnCollapsed(id, false);
    const left = columns.current[id]?.left;
    if (left !== undefined)
      scroller.current?.scrollTo({ x: Math.max(0, left - 12), animated: true });
  };
  const selectedMenu = groups.find((group) => group.id === menu);
  const selectedGroup = groups.find((group) => group.id === stage);
  const selectCompactGroup = (current: Stage, key: string) => {
    if (key === " " || key === "Spacebar") {
      setStage(current);
      return true;
    }
    const index = groups.findIndex((group) => group.id === current);
    if (index < 0) return false;
    const next =
      key === "Home"
        ? 0
        : key === "End"
          ? groups.length - 1
          : key === "ArrowLeft"
            ? (index - 1 + groups.length) % groups.length
            : key === "ArrowRight"
              ? (index + 1) % groups.length
              : -1;
    if (next < 0) return false;
    const selected = groups[next]!;
    setStage(selected.id);
    compactTabs.current[selected.id]?.focus();
    return true;
  };
  const dropHint =
    preview?.kind === "card" && target
      ? (target === preview.card!.stage
          ? t.dropToReorder
          : preview.card!.workspaceId === null && !isDraftGroup(target, groups)
            ? t.dropToStart
            : t.dropToGroup
        ).replace("{group}", stageTitle(target, groups, t))
      : t.dragCancelHint;

  return (
    <View style={styles.boardRoot}>
      {!compact && (
        <View style={styles.desktopNav}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t.groupLocator}
            disabled={!!preview}
            onPress={() => setLocatorOpen(true)}
            style={styles.iconButton}
          >
            <Icon name="List" size={18} color={theme.colors.foregroundMuted} />
          </Pressable>
        </View>
      )}
      <View
        ref={viewport}
        style={styles.viewport}
        onLayout={(event) => {
          setHeight(event.nativeEvent.layout.height);
          measureViewport();
        }}
      >
        {compact ? (
          <>
            <View style={styles.compactHeader}>
              <View
                accessibilityRole="radiogroup"
                accessibilityLabel={t.groups}
                style={{ flex: 1, minWidth: 0 }}
              >
                <ScrollView horizontal contentContainerStyle={styles.tabs}>
                  {groups.map((group) => (
                    <Pressable
                      key={group.id}
                      {...keyboardProps((key) =>
                        selectCompactGroup(group.id, key),
                      )}
                      accessibilityRole="radio"
                      accessibilityLabel={`${groupTitle(group, t)} (${displayCardsForStage(props, group.id).length})`}
                      aria-checked={stage === group.id}
                      accessibilityState={{ checked: stage === group.id }}
                      tabIndex={stage === group.id ? 0 : -1}
                      ref={(node) => {
                        compactTabs.current[group.id] = node;
                      }}
                      onPress={() => setStage(group.id)}
                      style={[
                        styles.tab,
                        stage === group.id && {
                          backgroundColor: theme.colors.surface2,
                          borderBottomColor: props.groupColor(group),
                        },
                      ]}
                    >
                      <View
                        style={[
                          styles.tabDot,
                          { backgroundColor: props.groupColor(group) },
                        ]}
                      />
                      <Text
                        numberOfLines={1}
                        style={[
                          styles.tabText,
                          {
                            color: theme.colors.foreground,
                            fontWeight: stage === group.id ? "600" : "400",
                          },
                        ]}
                      >
                        {groupTitle(group, t)} (
                        {displayCardsForStage(props, group.id).length})
                      </Text>
                    </Pressable>
                  ))}
                </ScrollView>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t.groupLocator}
                disabled={!!preview}
                onPress={() => setLocatorOpen(true)}
                style={styles.iconButton}
              >
                <Icon
                  name="List"
                  size={18}
                  color={theme.colors.foregroundMuted}
                />
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t.groupOptions}
                onPress={() => setMenu(stage)}
                style={styles.iconButton}
              >
                <Icon
                  name="Ellipsis"
                  size={18}
                  color={theme.colors.foregroundMuted}
                />
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t.addGroup}
                disabled={disabled}
                onPress={props.onAdd}
                style={styles.iconButton}
              >
                <Icon
                  name="Plus"
                  size={18}
                  color={theme.colors.foregroundMuted}
                />
              </Pressable>
            </View>
            <ScrollView key={stage} contentContainerStyle={styles.compactList}>
              {selectedGroup?.kind === "todo" &&
                props.renderQuickCreate?.(selectedGroup)}
              {displayCardsForStage(props, stage).length ? (
                displayCardsForStage(props, stage).map(
                  (card, index, visible) => (
                    <View
                      key={card.id}
                      testID={`workboard-order-${card.id}`}
                      tabIndex={0}
                      accessibilityHint={t.cardOrderHint}
                      {...cardKeys(card)}
                    >
                      {renderCard(card, false)}
                      <View style={{ flexDirection: "row", gap: 2 }}>
                        {([-1, 1] as const).map((direction) => (
                          <HintButton
                            key={direction}
                            hint={t.cardOrderHint}
                            accessibilityRole="button"
                            accessibilityLabel={`${direction < 0 ? t.moveCardUp : t.moveCardDown}: ${card.title}`}
                            disabled={
                              disabled ||
                              props.priorityFirst ||
                              props.orderPending?.has(card.stage) ||
                              !!card.archived ||
                              !!card.binding ||
                              !visible[index + direction]
                            }
                            onPress={() => moveCardRelative(card, direction)}
                            style={styles.iconButton}
                          >
                            <Icon
                              name={direction < 0 ? "ArrowUp" : "ArrowDown"}
                              size={14}
                              color={theme.colors.foregroundMuted}
                            />
                          </HintButton>
                        ))}
                      </View>
                    </View>
                  ),
                )
              ) : (
                <BoardEmpty
                  filtered={props.hasActiveFilter}
                  t={t}
                  theme={theme}
                  onClearFilters={props.onClearFilters}
                  onCreateTask={props.onCreateTask}
                />
              )}
            </ScrollView>
          </>
        ) : (
          <ScrollView
            ref={scroller}
            horizontal
            scrollEnabled={preview?.kind !== "resize"}
            onScroll={(event) => {
              scrollX.current = event.nativeEvent.contentOffset.x;
              if (session.current) queueTick();
            }}
            onContentSizeChange={(width) => {
              contentWidth.current = width;
            }}
            scrollEventThrottle={16}
            contentContainerStyle={[styles.columns, { height }]}
          >
            {groups.map((group) => {
              const stageCards =
                held?.[group.id] ?? displayCardsForStage(props, group.id);
              const isCollapsed = collapsed.has(group.id);
              return (
                <BoardColumn
                  key={group.id}
                  cancelKey={cancelKey}
                  group={group}
                  t={t}
                  theme={theme}
                  color={props.groupColor(group)}
                  width={groupWidth(group.id)}
                  count={stageCards.length}
                  createError={!!props.quickCreateErrors?.has(group.id)}
                  onListRef={(value) => {
                    listScrollers.current[group.id] = value;
                  }}
                  onListLayout={(bounds) => {
                    Object.assign(listState(group.id), bounds);
                  }}
                  onListScroll={(scrollY) => {
                    listState(group.id).scrollY = scrollY;
                  }}
                  onListContentHeight={(contentHeight) => {
                    listState(group.id).contentHeight = contentHeight;
                  }}
                  collapsed={isCollapsed}
                  disabled={
                    disabled || props.orderPending?.has(group.id) || !!preview
                  }
                  reordering={props.reordering}
                  active={target === group.id}
                  moving={preview?.kind === "group" && preview.id === group.id}
                  insertBefore={insertion === group.id}
                  insertAfter={insertion === null && group.id === order.at(-1)}
                  onMenu={() => setMenu(group.id)}
                  onToggleCollapsed={() =>
                    setColumnCollapsed(group.id, !isCollapsed)
                  }
                  collapseDisabled={!!preview}
                  onGroupBegin={(rect, x, y) => {
                    measureViewport();
                    begin("group", group.id, rect, x, y);
                  }}
                  onResizeBegin={(rect, x, y) => {
                    measureViewport();
                    begin("resize", group.id, rect, x, y);
                  }}
                  onMove={move}
                  onEnd={end}
                  onCancel={cancel}
                  onReorderKey={(direction) =>
                    void relativeMove(group.id, direction)
                  }
                  onWidthKey={(direction) =>
                    persistWidth(
                      group.id,
                      direction === 0
                        ? DEFAULT_COLUMN_WIDTH
                        : columnWidth(widths[group.id]) + direction * 20,
                    )
                  }
                >
                  {group.kind === "todo" && props.renderQuickCreate?.(group)}
                  {stageCards.length === 0 &&
                    (target === group.id ? (
                      <Text
                        style={[
                          styles.empty,
                          { color: theme.colors.foregroundMuted },
                        ]}
                      >
                        {t.dropHere}
                      </Text>
                    ) : (
                      <BoardEmpty
                        filtered={props.hasActiveFilter}
                        t={t}
                        theme={theme}
                        onClearFilters={props.onClearFilters}
                        onCreateTask={props.onCreateTask}
                      />
                    ))}
                  {stageCards.map((card) => (
                    <TaskDragShell
                      cancelKey={cancelKey}
                      key={card.id}
                      card={card}
                      onCardLayout={(top, height) => {
                        cardBounds.current[card.id] = { top, height };
                      }}
                      orderKeys={cardKeys(card)}
                      orderHint={t.cardOrderHint}
                      insertion={
                        cardInsertion?.stage === group.id &&
                        cardInsertion.anchor === card.id
                          ? cardInsertion.side
                          : null
                      }
                      theme={theme}
                      label={`${t.dragTask}: ${card.title}`}
                      disabled={
                        disabled ||
                        props.pendingStages?.has(card.id) ||
                        props.orderPending?.has(group.id) ||
                        card.binding !== null ||
                        card.archived !== null ||
                        !!preview
                      }
                      moving={
                        preview?.kind === "card" && preview.id === card.id
                      }
                      highlighted={
                        props.highlightedCards?.has(card.id) ?? false
                      }
                      onBegin={(rect, x, y) => {
                        measureViewport();
                        begin("card", card.id, rect, x, y, card);
                      }}
                      onMove={move}
                      onEnd={end}
                      onCancel={cancel}
                    >
                      {renderCard(card, true)}
                    </TaskDragShell>
                  ))}
                </BoardColumn>
              );
            })}
            <Pressable
              accessibilityRole="button"
              disabled={disabled || !!preview}
              onPress={props.onAdd}
              style={[
                styles.addColumn,
                {
                  borderColor: theme.colors.border,
                  backgroundColor: theme.colors.surface1,
                },
              ]}
            >
              <Icon
                name="Plus"
                size={16}
                color={theme.colors.foregroundMuted}
              />
              <Text style={{ color: theme.colors.foregroundMuted }}>
                {t.addGroup}
              </Text>
            </Pressable>
          </ScrollView>
        )}
        {preview && (
          // Disabled buttons can swallow mouseup; keep a plain release target above them.
          <View style={StyleSheet.absoluteFill} />
        )}
        {preview && preview.kind !== "resize" && (
          <Animated.View
            pointerEvents="none"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={[
              styles.ghost,
              {
                width: preview.rect.width,
                transform: position.getTranslateTransform(),
              },
            ]}
          >
            {preview.kind === "card" ? (
              renderCard(preview.card!, false)
            ) : (
              <View
                style={[
                  styles.groupGhost,
                  {
                    borderColor: theme.colors.accent,
                    backgroundColor: theme.colors.surface1,
                  },
                ]}
              >
                <Text
                  style={{ color: theme.colors.foreground, fontWeight: "600" }}
                >
                  {stageTitle(preview.id, groups, t)}
                </Text>
              </View>
            )}
          </Animated.View>
        )}
        {preview && (
          <View
            pointerEvents="none"
            style={[
              styles.dragNotice,
              {
                backgroundColor: theme.colors.surface0,
                borderColor: theme.colors.border,
              },
            ]}
          >
            <Text
              accessibilityLiveRegion="polite"
              style={{ color: theme.colors.foreground, fontSize: 12 }}
            >
              {preview.kind === "resize"
                ? `${columnWidth(widths[preview.id])} px · ${t.dragCancelHint}`
                : preview.kind === "card"
                  ? dropHint
                  : t.groupDragHint}
            </Text>
          </View>
        )}
        {selectedMenu && (
          <Modal
            open
            title={groupTitle(selectedMenu, t)}
            onOpenChange={(open) => {
              if (!open) setMenu(null);
            }}
          >
            <Modal.Content contentContainerStyle={{ padding: 12, gap: 4 }}>
              <MenuAction
                icon="Pencil"
                label={t.editGroup}
                disabled={disabled}
                theme={theme}
                onPress={() => {
                  setMenu(null);
                  props.onEdit(selectedMenu);
                }}
              />
              <MenuAction
                icon="Plus"
                label={t.addGroup}
                disabled={disabled}
                theme={theme}
                onPress={() => {
                  setMenu(null);
                  props.onAdd();
                }}
              />
              <MenuAction
                icon="List"
                label={t.groupLocator}
                theme={theme}
                onPress={() => {
                  setMenu(null);
                  setLocatorOpen(true);
                }}
              />
              <MenuAction
                icon="RotateCcw"
                label={t.resetCardOrder}
                theme={theme}
                disabled={
                  disabled ||
                  props.priorityFirst ||
                  props.orderPending?.has(selectedMenu.id) ||
                  !Object.hasOwn(props.cardOrderByStage, selectedMenu.id)
                }
                onPress={() => {
                  void props
                    .onResetCardOrder(
                      selectedMenu.id,
                      completeOrder(selectedMenu.id),
                    )
                    .then((ok) => {
                      if (ok) setMenu(null);
                    });
                }}
              />
              <MenuAction
                icon="ArrowLeft"
                label={t.moveGroupLeft}
                disabled={
                  disabled ||
                  props.reordering ||
                  order.indexOf(selectedMenu.id) === 0
                }
                theme={theme}
                onPress={() => void relativeMove(selectedMenu.id, -1)}
              />
              <MenuAction
                icon="ArrowRight"
                label={t.moveGroupRight}
                disabled={
                  disabled ||
                  props.reordering ||
                  order.indexOf(selectedMenu.id) === order.length - 1
                }
                theme={theme}
                onPress={() => void relativeMove(selectedMenu.id, 1)}
              />
              {!compact && (
                <>
                  <MenuAction
                    icon={
                      collapsed.has(selectedMenu.id)
                        ? "ChevronRight"
                        : "ChevronLeft"
                    }
                    label={
                      collapsed.has(selectedMenu.id)
                        ? t.expandColumn
                        : t.collapseColumn
                    }
                    theme={theme}
                    onPress={() => {
                      setColumnCollapsed(
                        selectedMenu.id,
                        !collapsed.has(selectedMenu.id),
                      );
                      setMenu(null);
                    }}
                  />
                  <MenuAction
                    icon="RotateCcw"
                    label={t.resetColumnWidth}
                    theme={theme}
                    onPress={() => {
                      persistWidth(selectedMenu.id, DEFAULT_COLUMN_WIDTH);
                      setMenu(null);
                    }}
                  />
                </>
              )}
              <MenuAction
                icon="Trash2"
                label={t.deleteGroup}
                disabled={disabled || !!props.deleteReason(selectedMenu)}
                danger
                theme={theme}
                onPress={() => {
                  setDeletingGroup(selectedMenu);
                  setMenu(null);
                }}
              />
              {props.deleteReason(selectedMenu) && (
                <Text
                  style={{
                    color: theme.colors.foregroundMuted,
                    fontSize: 12,
                    paddingHorizontal: 12,
                    paddingBottom: 8,
                  }}
                >
                  {props.deleteReason(selectedMenu)}
                </Text>
              )}
              {disabled && (
                <Text
                  accessibilityLiveRegion="polite"
                  style={{ color: theme.colors.foregroundMuted, padding: 12 }}
                >
                  {t.syncing}
                </Text>
              )}
            </Modal.Content>
          </Modal>
        )}
        {deletingGroup && (
          <ConfirmationModal
            title={t.deleteGroup}
            description={t.deleteGroupConfirm.replace(
              "{name}",
              groupTitle(deletingGroup, t),
            )}
            confirmLabel={t.deleteGroup}
            disabled={disabled || !!props.deleteReason(deletingGroup)}
            t={t}
            theme={theme}
            onClose={() => setDeletingGroup(null)}
            onConfirm={() => props.onDelete(deletingGroup)}
          />
        )}
        {locatorOpen && (
          <Modal
            open
            title={t.groupLocator}
            onOpenChange={(open) => {
              if (!open) setLocatorOpen(false);
            }}
          >
            <Modal.Content>
              <ScrollView style={styles.choiceList}>
                {groups.map((group) => (
                  <Pressable
                    key={group.id}
                    accessibilityRole="button"
                    accessibilityLabel={groupTitle(group, t)}
                    onPress={() => locateGroup(group.id)}
                    style={styles.menuAction}
                  >
                    <View
                      style={[
                        styles.locatorDot,
                        { backgroundColor: props.groupColor(group) },
                      ]}
                    />
                    <Text
                      numberOfLines={1}
                      style={{ flex: 1, color: theme.colors.foreground }}
                    >
                      {groupTitle(group, t)} (
                      {displayCardsForStage(props, group.id).length})
                    </Text>
                    {collapsed.has(group.id) && !compact && (
                      <Icon
                        name="ChevronRight"
                        size={16}
                        color={theme.colors.foregroundMuted}
                      />
                    )}
                  </Pressable>
                ))}
              </ScrollView>
            </Modal.Content>
          </Modal>
        )}
      </View>
    </View>
  );
}

function BoardEmpty({
  filtered,
  t,
  theme,
  onClearFilters,
  onCreateTask,
}: {
  filtered: boolean;
  t: BoardViewProps["t"];
  theme: Theme;
  onClearFilters?: () => void;
  onCreateTask?: () => void;
}) {
  return (
    <View style={styles.emptyState}>
      <Text style={[styles.empty, { color: theme.colors.foregroundMuted }]}>
        {filtered ? t.emptyFiltered : t.empty}
      </Text>
      {(filtered && onClearFilters) || onCreateTask ? (
        <View style={styles.emptyActions}>
          {filtered && onClearFilters && (
            <Pressable
              accessibilityRole="button"
              onPress={onClearFilters}
              style={styles.emptyAction}
            >
              <Text
                style={{
                  color: theme.colors.foreground,
                  textDecorationLine: "underline",
                }}
              >
                {t.clearFilters}
              </Text>
            </Pressable>
          )}
          {onCreateTask && (
            <Pressable
              accessibilityRole="button"
              onPress={onCreateTask}
              style={styles.emptyAction}
            >
              <Text
                style={{
                  color: theme.colors.foreground,
                  textDecorationLine: "underline",
                }}
              >
                {t.addTask}
              </Text>
            </Pressable>
          )}
        </View>
      ) : null}
    </View>
  );
}

function MenuAction({
  icon,
  label,
  disabled,
  danger,
  theme,
  onPress,
}: {
  icon: string;
  label: string;
  disabled?: boolean;
  danger?: boolean;
  theme: Theme;
  onPress(): void;
}) {
  const color = disabled
    ? theme.colors.foregroundMuted
    : danger
      ? theme.colors.statusDanger
      : theme.colors.foreground;
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.menuAction,
        {
          opacity: disabled ? 0.5 : 1,
          backgroundColor: pressed ? theme.colors.surface2 : undefined,
        },
      ]}
    >
      <Icon name={icon} size={16} color={color} />
      <Text style={{ color }}>{label}</Text>
    </Pressable>
  );
}

function TaskDragShell({
  card,
  theme,
  label,
  disabled,
  moving,
  highlighted,
  onCardLayout,
  orderKeys,
  orderHint,
  insertion,
  children,
  ...gesture
}: Omit<HandleProps, "measure"> & {
  card: Card;
  theme: Theme;
  label: string;
  moving: boolean;
  highlighted: boolean;
  onCardLayout(top: number, height: number): void;
  orderKeys: ReturnType<typeof keyboardProps>;
  orderHint: string;
  insertion: "before" | "after" | null;
  children: ReactNode;
}) {
  const measured = useRef<View>(null);
  const handlers = useDragHandle({
    ...gesture,
    disabled,
    measure: measured,
    captureStart: true,
  });
  return (
    <View
      ref={measured}
      testID={`workboard-card-${card.id}`}
      onLayout={(event) =>
        onCardLayout(
          event.nativeEvent.layout.y,
          event.nativeEvent.layout.height,
        )
      }
      style={[
        styles.task,
        moving && { opacity: 0.28 },
        highlighted && {
          outlineColor: theme.colors.accent,
          outlineWidth: 2,
          outlineStyle: "solid",
          borderRadius: 8,
        },
      ]}
    >
      {insertion && (
        <View
          pointerEvents="none"
          testID={`workboard-card-insertion-${card.stage}`}
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            height: 2,
            backgroundColor: theme.colors.accent,
            ...(insertion === "before" ? { top: -3 } : { bottom: -3 }),
          }}
        />
      )}
      {children}
      <View
        {...handlers}
        {...orderKeys}
        tabIndex={0}
        accessibilityHint={orderHint}
        accessible
        accessibilityLabel={label}
        accessibilityState={{ disabled }}
        testID={`workboard-drag-${card.id}`}
        style={[
          styles.cardHandle,
          dragCursor(),
          { opacity: disabled && !moving ? 0.35 : 1 },
        ]}
      >
        <Icon
          name="GripVertical"
          size={14}
          color={theme.colors.foregroundMuted}
        />
      </View>
    </View>
  );
}

function BoardColumn({
  group,
  color,
  width,
  count,
  createError,
  collapsed,
  disabled,
  active,
  moving,
  insertBefore,
  insertAfter,
  t,
  theme,
  children,
  onMenu,
  onToggleCollapsed,
  collapseDisabled,
  reordering = false,
  onGroupBegin,
  onResizeBegin,
  onReorderKey,
  onWidthKey,
  onListRef,
  onListLayout,
  onListScroll,
  onListContentHeight,
  ...gesture
}: Omit<HandleProps, "measure" | "onBegin"> & {
  group: Group;
  color: string;
  width: number;
  count: number;
  createError: boolean;
  collapsed: boolean;
  active: boolean;
  moving: boolean;
  insertBefore: boolean;
  insertAfter: boolean;
  t: BoardViewProps["t"];
  theme: Theme;
  children: ReactNode;
  onMenu(): void;
  onToggleCollapsed(): void;
  collapseDisabled: boolean;
  reordering?: boolean;
  onGroupBegin: HandleProps["onBegin"];
  onResizeBegin: HandleProps["onBegin"];
  onReorderKey(direction: number): void;
  onWidthKey(direction: number): void;
  onListRef(value: NativeScrollView | null): void;
  onListLayout(bounds: { top: number; height: number }): void;
  onListScroll(scrollY: number): void;
  onListContentHeight(height: number): void;
}) {
  const measured = useRef<View>(null);
  const list = useRef<NativeScrollView | null>(null);
  const header = useDragHandle({
    ...gesture,
    disabled: disabled || reordering,
    horizontal: true,
    measure: measured,
    onBegin: onGroupBegin,
  });
  const lastPress = useRef(0);
  const resize = useDragHandle({
    ...gesture,
    disabled,
    horizontal: true,
    captureStart: true,
    measure: measured,
    onBegin: onResizeBegin,
    onTap: () => {
      const now = Date.now();
      if (now - lastPress.current < 350) onWidthKey(0);
      lastPress.current = now;
    },
  });
  const [resizeHovered, setResizeHovered] = useState(false);
  const [resizeFocused, setResizeFocused] = useState(false);
  return (
    <View
      ref={measured}
      testID={`workboard-column-${group.id}`}
      style={[
        styles.column,
        collapsed && styles.columnCollapsed,
        {
          width,
          backgroundColor: active
            ? theme.colors.surface2
            : theme.colors.surface1,
          borderColor: active ? color : theme.colors.border,
          opacity: moving ? 0.4 : 1,
        },
      ]}
    >
      {insertBefore && (
        <View
          pointerEvents="none"
          style={[
            styles.insertion,
            { left: -7, backgroundColor: theme.colors.accent },
          ]}
        />
      )}
      {insertAfter && (
        <View
          pointerEvents="none"
          style={[
            styles.insertion,
            { right: -7, backgroundColor: theme.colors.accent },
          ]}
        />
      )}
      <View
        style={[styles.columnHeader, collapsed && styles.columnHeaderCollapsed]}
      >
        <View
          {...header}
          style={[{ flex: 1, minWidth: 0 }, collapsed && { width: "100%" }]}
        >
          <Pressable
            {...keyboardProps((key, event) => {
              if (disabled || reordering) return false;
              if (
                (event.altKey || event.metaKey) &&
                (key === "ArrowLeft" || key === "ArrowRight")
              ) {
                onReorderKey(key === "ArrowLeft" ? -1 : 1);
                return true;
              }
              return false;
            })}
            accessibilityRole="button"
            accessibilityLabel={`${t.groupOptions}: ${groupTitle(group, t)}`}
            accessibilityHint={`${t.dragGroup}. ${t.groupKeyboardHint}`}
            disabled={disabled || reordering}
            onPress={onMenu}
            testID={`workboard-column-drag-${group.id}`}
            style={[
              styles.columnTitle,
              collapsed && styles.columnTitleCollapsed,
              dragCursor(),
            ]}
          >
            <Icon
              name="GripVertical"
              size={13}
              color={theme.colors.foregroundMuted}
            />
            <View style={[styles.dot, { backgroundColor: color }]} />
            <Text
              numberOfLines={collapsed ? 2 : 1}
              style={{
                flex: 1,
                minWidth: 0,
                color: theme.colors.foreground,
                fontWeight: "600",
                fontSize: 13,
              }}
            >
              {groupTitle(group, t)}
            </Text>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
              {count}
            </Text>
          </Pressable>
        </View>
        {collapsed && createError && (
          <Text
            accessibilityRole="alert"
            style={{ color: theme.colors.statusWarning, fontSize: 12 }}
          >
            {t.quickCreateFailed}
          </Text>
        )}
        {!collapsed && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${t.groupOptions}: ${groupTitle(group, t)}`}
            disabled={disabled}
            onPress={onMenu}
            testID={`workboard-column-menu-${group.id}`}
            style={styles.iconButton}
          >
            <Icon
              name="Ellipsis"
              size={16}
              color={theme.colors.foregroundMuted}
            />
          </Pressable>
        )}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${collapsed ? t.expandColumn : t.collapseColumn}: ${groupTitle(group, t)}`}
          disabled={collapseDisabled}
          onPress={onToggleCollapsed}
          style={styles.iconButton}
        >
          <Icon
            name={collapsed ? "ChevronRight" : "ChevronLeft"}
            size={16}
            color={theme.colors.foregroundMuted}
          />
        </Pressable>
      </View>
      {!collapsed && (
        <ScrollView
          ref={(value) => {
            list.current = value;
            onListRef(value);
          }}
          onLayout={() =>
            list.current
              ?.getNativeScrollRef()
              ?.measureInWindow((_left, top, _width, height) =>
                onListLayout({ top, height }),
              )
          }
          onScroll={(event) => onListScroll(event.nativeEvent.contentOffset.y)}
          scrollEventThrottle={16}
          onContentSizeChange={(_width, height) => onListContentHeight(height)}
          style={{ flex: 1, marginRight: 28 }}
          contentContainerStyle={styles.cards}
        >
          {children}
        </ScrollView>
      )}
      {!collapsed && (
        <View
          {...resize}
          {...keyboardProps((key) => {
            if (disabled) return false;
            if (key === "ArrowLeft" || key === "ArrowRight") {
              onWidthKey(key === "ArrowLeft" ? -1 : 1);
              return true;
            }
            if (key === "Home" || key === "Enter") {
              onWidthKey(0);
              return true;
            }
            return false;
          })}
          accessibilityRole="adjustable"
          accessibilityLabel={`${t.resizeColumn}: ${groupTitle(group, t)}`}
          accessibilityHint={t.resizeHint}
          accessibilityValue={{
            min: MIN_COLUMN_WIDTH,
            max: MAX_COLUMN_WIDTH,
            now: width,
          }}
          accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
          onAccessibilityAction={(event) =>
            onWidthKey(event.nativeEvent.actionName === "increment" ? 1 : -1)
          }
          focusable={!disabled}
          accessibilityState={{ disabled }}
          testID={`workboard-resize-${group.id}`}
          onFocus={() => setResizeFocused(true)}
          onBlur={() => setResizeFocused(false)}
          onPointerEnter={() => setResizeHovered(true)}
          onPointerLeave={() => setResizeHovered(false)}
          style={[styles.resize, dragCursor(true)]}
        >
          <View
            pointerEvents="none"
            accessible={false}
            style={{
              flex: 1,
              width: "100%",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <View
              style={{
                width: resizeHovered || resizeFocused ? 4 : 2,
                height: 22,
                borderRadius: 1,
                backgroundColor:
                  resizeHovered || resizeFocused
                    ? theme.colors.accent
                    : theme.colors.border,
              }}
            />
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  boardRoot: { flex: 1, minHeight: 0 },
  viewport: { flex: 1, minHeight: 0, overflow: "hidden" },
  desktopNav: { minHeight: 36, alignItems: "flex-end", paddingRight: 12 },
  columns: {
    padding: COLUMN_PADDING,
    gap: COLUMN_GAP,
    alignItems: "stretch",
  },
  column: { borderWidth: 1, borderRadius: 10, padding: 8, gap: 6 },
  columnCollapsed: { alignSelf: "stretch" },
  columnHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    paddingBottom: 2,
  },
  columnHeaderCollapsed: { flexDirection: "column", alignItems: "stretch" },
  columnTitle: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    minHeight: 30,
  },
  columnTitleCollapsed: {
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
  },
  dot: { width: 6, height: 6, borderRadius: 3 },
  iconButton: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 6,
  },
  cards: { gap: 6, paddingBottom: 8 },
  empty: { fontSize: 12, paddingVertical: 20, textAlign: "center" },
  emptyState: { alignItems: "center", paddingVertical: 12, gap: 4 },
  emptyActions: { flexDirection: "row", gap: 8 },
  emptyAction: {
    minHeight: 36,
    paddingHorizontal: 8,
    justifyContent: "center",
  },
  addColumn: {
    width: 130,
    alignSelf: "flex-start",
    minHeight: 44,
    borderWidth: 1,
    borderStyle: "dashed",
    borderRadius: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  insertion: {
    position: "absolute",
    top: 0,
    bottom: 0,
    width: 3,
    borderRadius: 2,
  },
  resize: {
    position: "absolute",
    right: 0,
    top: 42,
    bottom: 0,
    width: 36,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 5,
  },
  task: { position: "relative" },
  cardHandle: {
    position: "absolute",
    right: 1,
    top: 1,
    width: 30,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 2,
  },
  ghost: {
    position: "absolute",
    left: 0,
    top: 0,
    zIndex: 20,
    opacity: 0.94,
    shadowColor: "#000000",
    shadowOpacity: 0.18,
    shadowRadius: 8,
    elevation: 6,
  },
  groupGhost: { borderWidth: 1, borderRadius: 10, padding: 12 },
  dragNotice: {
    position: "absolute",
    bottom: 12,
    alignSelf: "center",
    maxWidth: "90%",
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    zIndex: 21,
  },
  compactHeader: {
    flexDirection: "row",
    alignItems: "center",
    paddingRight: 6,
  },
  tabs: { padding: 8, gap: 6 },
  tab: {
    minHeight: 36,
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 9,
    paddingVertical: 6,
    borderRadius: 7,
    maxWidth: 240,
    borderBottomWidth: 2,
    borderBottomColor: "transparent",
  },
  tabDot: { width: 7, height: 7, borderRadius: 4, flexShrink: 0 },
  tabText: { flexShrink: 1 },
  compactList: { padding: 10, gap: 7 },
  menuAction: {
    minHeight: 40,
    paddingHorizontal: 12,
    borderRadius: 6,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  choiceList: { maxHeight: 280 },
  locatorDot: { width: 8, height: 8, borderRadius: 4 },
});

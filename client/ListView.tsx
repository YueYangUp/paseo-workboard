import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Animated,
  Pressable,
  StyleSheet,
  Text,
  View,
  type ScrollView as NativeScrollView,
} from "react-native";
import {
  Icon,
  Modal,
  ScrollView,
  useToast,
} from "@getpaseo/plugin/client/react-native";
import {
  isDraftGroup,
  type Card,
  type Group,
  type Stage,
} from "../shared/model";
import {
  cardsForStage,
  edgeScrollSpeed,
  moveCardToAnchor,
} from "./board-utils";
import { displayCardsForStage, type BoardViewProps } from "./BoardView";
import { type Bounds, useDragHandle } from "./drag-handle";
import {
  cardAnchorAtY,
  contentY,
  groupAtY,
  groupOrderAtY,
  rowBoundsInContent,
  stackedBounds,
  type VerticalBounds,
} from "./list-utils";
import { groupTitle, stageTitle } from "./strings";
import { dragCursor, duringDrag, keyboardProps } from "./web";
import { ConfirmationModal } from "./ConfirmationModal";

type Props = BoardViewProps & {
  collapsed: ReadonlySet<string>;
  onCollapsedChange(ids: string[]): void;
  quickCreateErrors?: ReadonlySet<string>;
};
type Gesture = {
  kind: "card" | "group";
  id: string;
  rect: Bounds;
  x: number;
  y: number;
  startX: number;
  startY: number;
  card?: Card;
  order: string[];
  expectedCardOrder: string[];
  visibleCardIds: string[];
  filterKey?: string;
};
type Insertion = { anchor: string; side: "before" | "after" };
const CONTENT_PADDING = 12;
const GROUP_GAP = 10;

export function ListView(props: Props) {
  const { groups, collapsed, disabled, t, theme } = props;
  const toast = useToast();
  const latest = useRef(props);
  latest.current = props;
  const viewport = useRef<View>(null);
  const scroller = useRef<NativeScrollView>(null);
  const viewportBounds = useRef<Bounds>({
    left: 0,
    top: 0,
    width: 0,
    height: 0,
  });
  const scrollY = useRef(0);
  const contentHeight = useRef(0);
  const groupBounds = useRef<Record<string, VerticalBounds>>({});
  const bodyOffsets = useRef<Record<string, number>>({});
  const quickCreateHeights = useRef<Record<string, number>>({});
  const rowBounds = useRef<Record<string, VerticalBounds>>({});
  const session = useRef<Gesture | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cleanup = useRef<() => void>(() => {});
  const position = useRef(new Animated.ValueXY()).current;
  const [preview, setPreview] = useState<Gesture | null>(null);
  const [held, setHeld] = useState<Record<string, Card[]> | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [groupInsertion, setGroupInsertion] = useState<
    string | null | undefined
  >();
  const [cardInsertion, setCardInsertion] = useState<Insertion | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [deletingGroup, setDeletingGroup] = useState<Group | null>(null);
  const order = groups.map((group) => group.id);
  const groupSignature = groups
    .map((group) => `${group.id}:${group.kind}:${group.label}`)
    .join("\n");
  const cardSignature = props.fullCards
    .map(
      (card) =>
        `${card.id}:${card.stage}:${card.priority ?? "p2"}:${card.binding?.stage ?? ""}:${card.archived?.status ?? ""}`,
    )
    .join("\n");
  const collapsedSignature = [...collapsed].sort().join("\n");
  const pendingSignature = [
    ...(props.pendingStages ?? []),
    ...(props.orderPending ?? []),
  ]
    .sort()
    .join("\n");
  const cancelKey = JSON.stringify([
    disabled,
    groupSignature,
    cardSignature,
    props.filterKey,
    collapsedSignature,
    pendingSignature,
    props.compact,
    props.priorityFirst,
  ]);

  const completeOrder = (stage: Stage) =>
    cardsForStage(
      latest.current.fullCards,
      stage,
      latest.current.cardOrderByStage,
    ).map((card) => card.id);
  const inside = (x: number, y: number) => {
    const view = viewportBounds.current;
    return (
      x >= view.left &&
      x <= view.left + view.width &&
      y >= view.top &&
      y <= view.top + view.height
    );
  };
  const atY = (y: number) =>
    contentY(y, viewportBounds.current.top, scrollY.current);
  const currentGroupBounds = (order: readonly string[]) =>
    stackedBounds(order, groupBounds.current, CONTENT_PADDING, GROUP_GAP);
  const anchorAt = (current: Gesture, y: number) =>
    cardAnchorAtY(
      atY(y),
      current.id,
      current.visibleCardIds,
      rowBoundsInContent(
        current.visibleCardIds,
        rowBounds.current,
        currentGroupBounds(current.order)[current.card!.stage]?.top ?? 0,
        bodyOffsets.current[current.card!.stage] ?? 0,
        quickCreateHeights.current[current.card!.stage] ?? 0,
      ),
    );
  const clearGesture = () => {
    session.current = null;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    cleanup.current();
    cleanup.current = () => {};
    setPreview(null);
    setHeld(null);
    setTarget(null);
    setGroupInsertion(undefined);
    setCardInsertion(null);
  };
  const cancel = () => clearGesture();
  useEffect(() => {
    cancel();
  }, [cancelKey]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      cleanup.current();
    },
    [],
  );

  const reorderCards = async (
    card: Card,
    expected: string[],
    next: string[],
  ) => {
    setAnnouncement("");
    if (await latest.current.onReorderCards(card, expected, next))
      setAnnouncement(t.taskOrderSaved.replace("{task}", card.title));
  };
  const reorderGroups = async (next: string[], expected: string[]) => {
    setAnnouncement("");
    if (await latest.current.onReorder(next, expected))
      setAnnouncement(t.layoutSaved);
  };

  const queueTick = () => {
    if (!timer.current) timer.current = setTimeout(tick, 16);
  };
  const tick = () => {
    timer.current = null;
    const current = session.current;
    if (!current) return;
    const view = viewportBounds.current;
    position.setValue({
      x: current.rect.left - view.left + current.x - current.startX,
      y: current.rect.top - view.top + current.y - current.startY,
    });
    const speed = inside(current.x, current.y)
      ? edgeScrollSpeed(current.y - view.top, view.height)
      : 0;
    const nextScroll = Math.max(
      0,
      Math.min(
        Math.max(0, contentHeight.current - view.height),
        scrollY.current + speed * 0.016,
      ),
    );
    if (nextScroll !== scrollY.current) {
      scrollY.current = nextScroll;
      scroller.current?.scrollTo({ y: nextScroll, animated: false });
      queueTick();
    }
    if (!inside(current.x, current.y)) {
      setTarget(null);
      setGroupInsertion(undefined);
      setCardInsertion(null);
      return;
    }
    const y = atY(current.y);
    const bounds = currentGroupBounds(current.order);
    if (current.kind === "group") {
      const next = groupOrderAtY(current.order, current.id, y, bounds);
      setGroupInsertion(next[next.indexOf(current.id) + 1] ?? null);
      return;
    }
    const destination = groupAtY(y, current.order, bounds);
    setTarget(destination);
    setCardInsertion(
      destination === current.card?.stage && !latest.current.priorityFirst
        ? anchorAt(current, current.y)
        : null,
    );
  };
  const begin = (
    kind: Gesture["kind"],
    id: string,
    rect: Bounds,
    x: number,
    y: number,
    card?: Card,
  ) => {
    if (
      latest.current.disabled ||
      session.current ||
      (kind === "group" && latest.current.reordering)
    )
      return;
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
      expectedCardOrder: card ? completeOrder(card.stage) : [],
      visibleCardIds: card
        ? displayCardsForStage(latest.current, card.stage).map(
            (item) => item.id,
          )
        : [],
      filterKey: latest.current.filterKey,
    };
    session.current = current;
    setPreview(current);
    setHeld(
      Object.fromEntries(
        latest.current.groups.map((group) => [
          group.id,
          displayCardsForStage(latest.current, group.id),
        ]),
      ),
    );
    position.setValue({
      x: rect.left - viewportBounds.current.left,
      y: rect.top - viewportBounds.current.top,
    });
    cleanup.current = duringDrag(cancel);
    queueTick();
  };
  const move = (x: number, y: number) => {
    if (session.current) {
      session.current.x = x;
      session.current.y = y;
      queueTick();
    }
  };
  const end = (x: number, y: number) => {
    const current = session.current;
    if (!current) return;
    const liveProps = latest.current;
    const valid =
      !liveProps.disabled &&
      current.filterKey === liveProps.filterKey &&
      current.order.join("\n") ===
        liveProps.groups.map((group) => group.id).join("\n");
    clearGesture();
    if (!valid || !inside(x, y)) return;
    const bounds = currentGroupBounds(current.order);
    const destination = groupAtY(atY(y), current.order, bounds);
    if (current.kind === "group") {
      if (liveProps.reordering) return;
      const next = groupOrderAtY(current.order, current.id, atY(y), bounds);
      if (next.join("\n") !== current.order.join("\n"))
        void reorderGroups(next, current.order);
      return;
    }
    if (!current.card || !destination) return;
    const live = liveProps.fullCards.find((card) => card.id === current.id);
    if (
      !live ||
      live.archived ||
      live.binding ||
      live.stage !== current.card.stage ||
      liveProps.pendingStages?.has(live.id)
    ) {
      toast.show(t.dragChanged, { variant: "warning" });
      return;
    }
    if (destination !== current.card.stage) {
      void liveProps.onStage(live, destination);
      return;
    }
    if (liveProps.priorityFirst || liveProps.orderPending?.has(destination))
      return;
    const anchor = anchorAt(current, y);
    if (!anchor) return;
    const next = moveCardToAnchor(
      current.expectedCardOrder,
      current.id,
      anchor.anchor,
      anchor.side,
    );
    if (next.join("\n") !== current.expectedCardOrder.join("\n"))
      void reorderCards(live, current.expectedCardOrder, next);
  };
  const measureViewport = () =>
    viewport.current?.measureInWindow((left, top, width, height) => {
      viewportBounds.current = { left, top, width, height };
    });
  const setCollapsed = (id: string, value: boolean) => {
    const next = new Set(latest.current.collapsed);
    if (value) next.add(id);
    else next.delete(id);
    latest.current.onCollapsedChange([...next]);
  };
  const relativeGroup = (id: string, direction: number) => {
    const ids = latest.current.groups.map((group) => group.id);
    const index = ids.indexOf(id),
      destination = index + direction;
    if (
      latest.current.disabled ||
      latest.current.reordering ||
      destination < 0 ||
      destination >= ids.length
    )
      return;
    const next = [...ids];
    next.splice(index, 1);
    next.splice(destination, 0, id);
    void reorderGroups(next, ids);
  };
  const relativeCard = (card: Card, direction: number) => {
    const current = latest.current;
    const live = current.fullCards.find((item) => item.id === card.id);
    if (
      current.disabled ||
      current.priorityFirst ||
      !live ||
      live.stage !== card.stage ||
      current.pendingStages?.has(live.id) ||
      current.orderPending?.has(live.stage) ||
      live.binding ||
      live.archived
    )
      return;
    const visible = displayCardsForStage(current, live.stage);
    const neighbor =
      visible[visible.findIndex((item) => item.id === card.id) + direction];
    if (!neighbor) return;
    const expected = completeOrder(live.stage);
    void reorderCards(
      live,
      expected,
      moveCardToAnchor(
        expected,
        card.id,
        neighbor.id,
        direction < 0 ? "before" : "after",
      ),
    );
  };
  const selectedMenu = groups.find((group) => group.id === menu);
  const dropHint =
    preview?.kind === "card" && target
      ? (target === preview.card!.stage
          ? props.priorityFirst
            ? t.dragCancelHint
            : t.listDropToReorder
          : preview.card!.workspaceId === null && !isDraftGroup(target, groups)
            ? t.dropToStart
            : t.dropToGroup
        ).replace("{group}", stageTitle(target, groups, t))
      : t.dragCancelHint;

  return (
    <View style={styles.root}>
      <View style={styles.tools}>
        <Text
          accessibilityLiveRegion="polite"
          style={{ flex: 1, color: theme.colors.foregroundMuted, fontSize: 12 }}
        >
          {announcement}
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => props.onCollapsedChange([])}
          style={styles.tool}
        >
          <Text style={{ color: theme.colors.foregroundMuted }}>
            {t.expandAll}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={() => props.onCollapsedChange(order)}
          style={styles.tool}
        >
          <Text style={{ color: theme.colors.foregroundMuted }}>
            {t.collapseAll}
          </Text>
        </Pressable>
      </View>
      <View ref={viewport} style={styles.viewport} onLayout={measureViewport}>
        <ScrollView
          ref={scroller}
          onScroll={(event) => {
            scrollY.current = event.nativeEvent.contentOffset.y;
            if (session.current) queueTick();
          }}
          scrollEventThrottle={16}
          onContentSizeChange={(_width, height) => {
            contentHeight.current = height;
          }}
          contentContainerStyle={styles.content}
        >
          {groups.map((group) => {
            const visible =
              held?.[group.id] ?? displayCardsForStage(props, group.id);
            const total = cardsForStage(
              props.fullCards,
              group.id,
              props.cardOrderByStage,
            ).length;
            const isCollapsed = collapsed.has(group.id);
            const groupTarget =
              target === group.id &&
              preview?.kind === "card" &&
              preview.card?.stage !== group.id;
            return (
              <ListGroup
                cancelKey={cancelKey}
                key={group.id}
                group={group}
                count={visible.length}
                total={total}
                collapsed={isCollapsed}
                active={!!groupTarget}
                moving={preview?.kind === "group" && preview.id === group.id}
                insertBefore={groupInsertion === group.id}
                insertAfter={
                  groupInsertion === null && group.id === order.at(-1)
                }
                color={props.groupColor(group)}
                t={t}
                theme={theme}
                disabled={disabled || !!props.reordering}
                createError={!!props.quickCreateErrors?.has(group.id)}
                hasActiveFilter={props.hasActiveFilter}
                onLayout={(top, height) => {
                  groupBounds.current[group.id] = { top, height };
                }}
                onBodyLayout={(top) => {
                  bodyOffsets.current[group.id] = top;
                }}
                onToggle={() => setCollapsed(group.id, !isCollapsed)}
                onMenu={() => setMenu(group.id)}
                onBegin={(rect, x, y) => begin("group", group.id, rect, x, y)}
                onMove={move}
                onEnd={end}
                onCancel={cancel}
                onReorderKey={(direction) => relativeGroup(group.id, direction)}
              >
                {group.kind === "todo" && props.renderQuickCreate && (
                  <View
                    onLayout={(event) => {
                      quickCreateHeights.current[group.id] =
                        event.nativeEvent.layout.height;
                    }}
                  >
                    {props.renderQuickCreate(group)}
                  </View>
                )}
                {visible.length === 0 ? (
                  <Text
                    style={[
                      styles.empty,
                      { color: theme.colors.foregroundMuted },
                    ]}
                  >
                    {total > 0 ? t.emptyFiltered : t.empty}
                  </Text>
                ) : (
                  visible.map((card, index) => (
                    <ListTask
                      cancelKey={cancelKey}
                      key={card.id}
                      card={card}
                      canMoveUp={!props.priorityFirst && index > 0}
                      canMoveDown={
                        !props.priorityFirst && index < visible.length - 1
                      }
                      disabled={
                        disabled ||
                        !!props.pendingStages?.has(card.id) ||
                        !!props.orderPending?.has(group.id) ||
                        !!preview ||
                        !!card.binding ||
                        !!card.archived
                      }
                      moving={preview?.id === card.id}
                      highlighted={!!props.highlightedCards?.has(card.id)}
                      insertion={
                        cardInsertion?.anchor === card.id && target === group.id
                          ? cardInsertion.side
                          : null
                      }
                      t={t}
                      theme={theme}
                      onLayout={(top, height) => {
                        rowBounds.current[card.id] = { top, height };
                      }}
                      onBegin={(rect, x, y) =>
                        begin("card", card.id, rect, x, y, card)
                      }
                      onMove={move}
                      onEnd={end}
                      onCancel={cancel}
                      onReorderKey={(direction) =>
                        relativeCard(card, direction)
                      }
                    >
                      {props.renderCard(card, false)}
                    </ListTask>
                  ))
                )}
              </ListGroup>
            );
          })}
        </ScrollView>
        {preview && (
          <Animated.View
            pointerEvents="none"
            style={[
              styles.ghost,
              {
                backgroundColor: theme.colors.surface2,
                borderColor: theme.colors.accent,
                width: Math.min(
                  preview.rect.width,
                  viewportBounds.current.width - 24,
                ),
                minHeight: preview.kind === "group" ? 42 : 64,
                transform: position.getTranslateTransform(),
              },
            ]}
          >
            {preview.kind === "card" ? (
              props.renderCard(preview.card!, false)
            ) : (
              <Text style={{ color: theme.colors.foreground }}>
                {stageTitle(preview.id, groups, t)}
              </Text>
            )}
          </Animated.View>
        )}
        {preview && (
          <View
            pointerEvents="none"
            style={[
              styles.feedback,
              {
                backgroundColor: theme.colors.surface2,
                borderColor: theme.colors.border,
              },
            ]}
          >
            <Text
              accessibilityLiveRegion="polite"
              style={{ color: theme.colors.foreground, fontSize: 12 }}
            >
              {preview.kind === "card" ? dropHint : t.groupDragHint}
            </Text>
          </View>
        )}
      </View>
      {selectedMenu && (
        <Modal
          open
          title={groupTitle(selectedMenu, t)}
          onOpenChange={(open) => {
            if (!open) setMenu(null);
          }}
        >
          <Modal.Content contentContainerStyle={styles.menu}>
            <Action
              icon="Pencil"
              label={t.editGroup}
              disabled={disabled}
              theme={theme}
              onPress={() => {
                setMenu(null);
                props.onEdit(selectedMenu);
              }}
            />
            <Action
              icon="Plus"
              label={t.addGroup}
              disabled={disabled}
              theme={theme}
              onPress={() => {
                setMenu(null);
                props.onAdd();
              }}
            />
            <Action
              icon="RotateCcw"
              label={t.resetCardOrder}
              disabled={
                disabled ||
                props.priorityFirst ||
                !!props.orderPending?.has(selectedMenu.id) ||
                !Object.hasOwn(props.cardOrderByStage, selectedMenu.id)
              }
              theme={theme}
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
            <Action
              icon="ArrowUp"
              label={t.moveGroupUp}
              disabled={
                disabled ||
                !!props.reordering ||
                order.indexOf(selectedMenu.id) === 0
              }
              theme={theme}
              onPress={() => relativeGroup(selectedMenu.id, -1)}
            />
            <Action
              icon="ArrowDown"
              label={t.moveGroupDown}
              disabled={
                disabled ||
                !!props.reordering ||
                order.indexOf(selectedMenu.id) === order.length - 1
              }
              theme={theme}
              onPress={() => relativeGroup(selectedMenu.id, 1)}
            />
            <Action
              icon={
                collapsed.has(selectedMenu.id) ? "ChevronDown" : "ChevronRight"
              }
              label={
                collapsed.has(selectedMenu.id) ? t.expandGroup : t.collapseGroup
              }
              theme={theme}
              onPress={() => {
                setCollapsed(selectedMenu.id, !collapsed.has(selectedMenu.id));
                setMenu(null);
              }}
            />
            <Action
              icon="Trash2"
              label={t.deleteGroup}
              disabled={disabled || !!props.deleteReason(selectedMenu)}
              theme={theme}
              onPress={() => {
                setDeletingGroup(selectedMenu);
                setMenu(null);
              }}
            />
            {props.deleteReason(selectedMenu) && (
              <Text style={{ color: theme.colors.foregroundMuted, padding: 8 }}>
                {props.deleteReason(selectedMenu)}
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
    </View>
  );
}

type CommonGesture = {
  cancelKey: string;
  onBegin(rect: Bounds, x: number, y: number): void;
  onMove(x: number, y: number): void;
  onEnd(x: number, y: number): void;
  onCancel(): void;
};
type GroupProps = CommonGesture & {
  group: Group;
  count: number;
  total: number;
  collapsed: boolean;
  active: boolean;
  moving: boolean;
  insertBefore: boolean;
  insertAfter: boolean;
  color: string;
  t: Props["t"];
  theme: Props["theme"];
  disabled: boolean;
  createError: boolean;
  hasActiveFilter: boolean;
  children: ReactNode;
  onLayout(top: number, height: number): void;
  onBodyLayout(top: number): void;
  onToggle(): void;
  onMenu(): void;
  onReorderKey(direction: number): void;
};
function ListGroup(props: GroupProps) {
  const { group, collapsed, theme, t } = props;
  const measured = useRef<View>(null);
  const handlers = useDragHandle({
    measure: measured,
    disabled: props.disabled,
    cancelKey: props.cancelKey,
    captureStart: true,
    onBegin: props.onBegin,
    onMove: props.onMove,
    onEnd: props.onEnd,
    onCancel: props.onCancel,
  });
  return (
    <View
      ref={measured}
      testID={`workboard-list-group-${group.id}`}
      onLayout={(event) =>
        props.onLayout(
          event.nativeEvent.layout.y,
          event.nativeEvent.layout.height,
        )
      }
      style={[
        styles.group,
        {
          backgroundColor: props.active
            ? `${props.color}30`
            : `${props.color}18`,
          borderColor: props.active ? props.color : `${props.color}55`,
          opacity: props.moving ? 0.4 : 1,
        },
      ]}
    >
      {props.insertBefore && (
        <View
          pointerEvents="none"
          style={[
            styles.line,
            { top: -3, backgroundColor: theme.colors.accent },
          ]}
        />
      )}
      {props.insertAfter && (
        <View
          pointerEvents="none"
          style={[
            styles.line,
            { bottom: -3, backgroundColor: theme.colors.accent },
          ]}
        />
      )}
      <View style={styles.header}>
        <View
          {...handlers}
          {...keyboardProps((key, event) => {
            if (
              !event.altKey ||
              props.disabled ||
              (key !== "ArrowUp" && key !== "ArrowDown")
            )
              return false;
            props.onReorderKey(key === "ArrowUp" ? -1 : 1);
            return true;
          })}
          tabIndex={0}
          accessible
          accessibilityRole="button"
          accessibilityLabel={`${t.dragGroup}: ${groupTitle(group, t)}`}
          accessibilityHint={t.groupKeyboardHintList}
          accessibilityState={{ disabled: props.disabled }}
          testID={`workboard-list-group-drag-${group.id}`}
          style={[styles.handle, dragCursor()]}
        >
          <Icon
            name="GripVertical"
            size={16}
            color={theme.colors.foregroundMuted}
          />
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${collapsed ? t.expandGroup : t.collapseGroup}: ${groupTitle(group, t)}`}
          accessibilityState={{ expanded: !collapsed }}
          onPress={props.onToggle}
          style={styles.heading}
        >
          <Icon
            name={collapsed ? "ChevronRight" : "ChevronDown"}
            size={16}
            color={theme.colors.foregroundMuted}
          />
          <View style={[styles.dot, { backgroundColor: props.color }]} />
          <Text
            numberOfLines={1}
            style={{
              color: theme.colors.foreground,
              fontWeight: "600",
              flexShrink: 1,
            }}
          >
            {groupTitle(group, t)}
          </Text>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
            {props.hasActiveFilter
              ? t.listGroupCount
                  .replace("{matched}", String(props.count))
                  .replace("{total}", String(props.total))
              : `${props.count}`}
          </Text>
          {props.createError && (
            <View accessible accessibilityLabel={t.quickCreateFailed}>
              <Icon
                name="CircleAlert"
                size={14}
                color={theme.colors.statusDanger}
              />
            </View>
          )}
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${t.groupOptions}: ${groupTitle(group, t)}`}
          onPress={props.onMenu}
          style={styles.handle}
          testID={`workboard-list-group-menu-${group.id}`}
        >
          <Icon
            name="Ellipsis"
            size={17}
            color={theme.colors.foregroundMuted}
          />
        </Pressable>
      </View>
      {collapsed ? (
        props.count > 0 &&
        props.hasActiveFilter && (
          <Pressable onPress={props.onToggle} style={styles.collapsedHint}>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
              {t.expandToSeeMatches}
            </Text>
          </Pressable>
        )
      ) : (
        <View
          onLayout={(event) => props.onBodyLayout(event.nativeEvent.layout.y)}
          style={styles.body}
        >
          {props.children}
        </View>
      )}
    </View>
  );
}

type TaskProps = CommonGesture & {
  card: Card;
  canMoveUp: boolean;
  canMoveDown: boolean;
  disabled: boolean;
  moving: boolean;
  highlighted: boolean;
  insertion: "before" | "after" | null;
  t: Props["t"];
  theme: Props["theme"];
  children: ReactNode;
  onLayout(top: number, height: number): void;
  onReorderKey(direction: number): void;
};
function ListTask(props: TaskProps) {
  const measured = useRef<View>(null);
  const handlers = useDragHandle({
    measure: measured,
    disabled: props.disabled,
    cancelKey: props.cancelKey,
    captureStart: true,
    onBegin: props.onBegin,
    onMove: props.onMove,
    onEnd: props.onEnd,
    onCancel: props.onCancel,
  });
  return (
    <View
      ref={measured}
      testID={`workboard-list-task-${props.card.id}`}
      onLayout={(event) =>
        props.onLayout(
          event.nativeEvent.layout.y,
          event.nativeEvent.layout.height,
        )
      }
      style={[
        styles.task,
        {
          borderTopColor: props.theme.colors.border,
          opacity: props.moving ? 0.35 : 1,
        },
        props.highlighted && {
          outlineColor: props.theme.colors.accent,
          outlineWidth: 2,
          outlineStyle: "solid",
        },
      ]}
    >
      {props.insertion && (
        <View
          pointerEvents="none"
          testID={`workboard-list-insertion-${props.card.stage}`}
          style={[
            styles.line,
            {
              backgroundColor: props.theme.colors.accent,
              ...(props.insertion === "before" ? { top: -2 } : { bottom: -2 }),
            },
          ]}
        />
      )}
      <View
        {...handlers}
        {...keyboardProps((key, event) => {
          if (
            !event.altKey ||
            props.disabled ||
            (key !== "ArrowUp" && key !== "ArrowDown")
          )
            return false;
          props.onReorderKey(key === "ArrowUp" ? -1 : 1);
          return true;
        })}
        tabIndex={0}
        accessible
        accessibilityRole="button"
        accessibilityLabel={`${props.t.dragTask}: ${props.card.title}`}
        accessibilityHint={props.t.listCardOrderHint}
        accessibilityState={{ disabled: props.disabled }}
        style={[styles.handle, dragCursor()]}
        testID={`workboard-list-task-drag-${props.card.id}`}
      >
        <Icon
          name="GripVertical"
          size={15}
          color={props.theme.colors.foregroundMuted}
        />
      </View>
      <View style={styles.taskContent}>{props.children}</View>
      <View style={styles.moveButtons}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${props.t.moveCardUp}: ${props.card.title}`}
          disabled={props.disabled || !props.canMoveUp}
          onPress={() => props.onReorderKey(-1)}
          style={styles.miniButton}
        >
          <Icon
            name="ChevronUp"
            size={13}
            color={props.theme.colors.foregroundMuted}
          />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${props.t.moveCardDown}: ${props.card.title}`}
          disabled={props.disabled || !props.canMoveDown}
          onPress={() => props.onReorderKey(1)}
          style={styles.miniButton}
        >
          <Icon
            name="ChevronDown"
            size={13}
            color={props.theme.colors.foregroundMuted}
          />
        </Pressable>
      </View>
    </View>
  );
}

function Action({
  icon,
  label,
  disabled,
  theme,
  onPress,
}: {
  icon: string;
  label: string;
  disabled?: boolean;
  theme: Props["theme"];
  onPress(): void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={[styles.action, { opacity: disabled ? 0.45 : 1 }]}
    >
      <Icon name={icon} size={16} color={theme.colors.foreground} />
      <Text style={{ color: theme.colors.foreground }}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, minHeight: 0 },
  tools: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 12,
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  tool: { paddingHorizontal: 6, paddingVertical: 6 },
  viewport: { flex: 1, minHeight: 0, overflow: "hidden" },
  content: { padding: CONTENT_PADDING, gap: GROUP_GAP },
  group: {
    borderWidth: 1,
    borderRadius: 10,
    position: "relative",
    overflow: "visible",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 46,
    paddingHorizontal: 6,
  },
  heading: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 10,
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  handle: {
    width: 30,
    minHeight: 34,
    justifyContent: "center",
    alignItems: "center",
  },
  body: { paddingHorizontal: 8, paddingBottom: 8 },
  task: {
    flexDirection: "row",
    alignItems: "center",
    borderTopWidth: 1,
    minHeight: 52,
    position: "relative",
  },
  taskContent: { flex: 1, minWidth: 0, paddingVertical: 4 },
  moveButtons: { width: 24, alignItems: "center" },
  miniButton: { paddingVertical: 3 },
  empty: { padding: 12, fontSize: 13 },
  collapsedHint: { paddingHorizontal: 36, paddingBottom: 8 },
  line: { position: "absolute", left: 0, right: 0, height: 2, zIndex: 2 },
  ghost: {
    position: "absolute",
    top: 0,
    left: 0,
    zIndex: 5,
    borderWidth: 1,
    borderRadius: 8,
    padding: 6,
    opacity: 0.95,
  },
  feedback: {
    position: "absolute",
    bottom: 8,
    alignSelf: "center",
    zIndex: 6,
    borderWidth: 1,
    borderRadius: 8,
    padding: 8,
  },
  menu: { padding: 12, gap: 4 },
  action: {
    minHeight: 38,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 12,
  },
});

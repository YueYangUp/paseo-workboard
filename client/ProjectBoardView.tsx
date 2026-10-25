import { Pressable, Text, View } from "react-native";
import { Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import { BoardView, type BoardViewProps } from "./BoardView";
import { stageTitle } from "./strings";
import { taskSections } from "./project-groups";

/** Each native project is one collapsible lane with the original status columns and drag behavior. */
export function ProjectBoardView(
  props: BoardViewProps & {
    onCreateInProject?(projectId: string | null): void;
    collapsed: ReadonlySet<string>;
    onCollapsedChange(ids: string[]): void;
  },
) {
  const { t, theme, collapsed } = props;
  const sections = taskSections({
    ...props,
    groupBy: "project",
    priorityFirst: false,
    unassigned: t.unassigned,
    stageTitle: (stage) => stageTitle(stage, props.groups, t),
  });
  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ padding: 12, gap: 14 }}
    >
      {sections.length === 0 ? (
        <Text style={{ color: theme.colors.foregroundMuted }}>
          {props.hasActiveFilter ? t.emptyFiltered : t.empty}
        </Text>
      ) : null}
      {sections.map((section) => {
        const largestColumn = Math.max(
          1,
          ...props.groups.map(
            (g) => section.cards.filter((c) => c.stage === g.id).length,
          ),
        );
        return (
          <View
            key={section.id}
            testID={`workboard-project-lane-${section.id}`}
            style={{
              borderWidth: 1,
              borderColor: theme.colors.border,
              borderRadius: 10,
              overflow: "hidden",
            }}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${collapsed.has(section.id) ? t.expandGroup : t.collapseGroup}: ${section.title}`}
              accessibilityState={{ expanded: !collapsed.has(section.id) }}
              onPress={() => {
                const next = new Set(collapsed);
                if (next.has(section.id)) next.delete(section.id);
                else next.add(section.id);
                props.onCollapsedChange([...next]);
              }}
              style={{
                minHeight: 40,
                padding: 10,
                flexDirection: "row",
                gap: 8,
                alignItems: "center",
                backgroundColor: theme.colors.surface1,
              }}
            >
              <Icon
                name={
                  collapsed.has(section.id) ? "ChevronRight" : "ChevronDown"
                }
                size={16}
                color={theme.colors.foregroundMuted}
              />
              <Text
                numberOfLines={2}
                style={{
                  flex: 1,
                  color: theme.colors.foreground,
                  fontWeight: "600",
                }}
              >
                {section.title}
              </Text>
              <Text style={{ color: theme.colors.foregroundMuted }}>
                {section.cards.length} / {section.total}
              </Text>
            </Pressable>
            {!collapsed.has(section.id) ? (
              <View
                style={{ height: Math.min(700, 110 + largestColumn * 215) }}
              >
                <BoardView
                  {...props}
                  cards={section.cards}
                  renderQuickCreate={undefined}
                  onCreateTask={
                    props.onCreateInProject
                      ? () =>
                          props.onCreateInProject!(section.cards[0].projectId)
                      : undefined
                  }
                />
              </View>
            ) : null}
          </View>
        );
      })}
    </ScrollView>
  );
}

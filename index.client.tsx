import { type PluginClientContext, type PluginSidebarItemProps, useRpc } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { Text } from "react-native";
import { DatawiseApp } from "./client/app";
import { SqlFilePanel, SqliteFilePanel } from "./client/file-panels";
import { SettingsScreen } from "./client/settings-screen";
import { rpc, structureAttachment } from "./shared/contracts";

function SidebarItem({ currentScreen, openScreen, theme }: PluginSidebarItemProps) {
  const listRequests = useRpc(rpc.listAgentRequests);
  // Slower than inside Datawise, because this runs all the time. A request can otherwise wait unseen.
  const requests = useQuery({ queryKey: ["datawise", "agent-requests", "sidebar"], queryFn: () => listRequests({}), refetchInterval: 15000, retry: false });
  const waiting = (requests.data?.requests ?? []).filter((request) => request.status === "pending").length;
  return <SidebarRow icon="Database" active={currentScreen?.screenId === "main"} onPress={() => openScreen({ screenId: "main" })} trailing={waiting > 0 ? <Text style={{ color: theme.colors.statusWarning, fontSize: 12, fontWeight: "600", paddingRight: 8 }}>{waiting}</Text> : undefined} />;
}

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: "main", title: "Datawise", Component: DatawiseApp });
  client.addSidebarHeaderItem({ id: "main", title: "Datawise", Component: SidebarItem });
  client.addWorkspacePanel({ id: "browser", title: "Datawise", icon: "Database", Component: DatawiseApp });
  client.addSettingsScreen({ id: "preferences", title: "Preferences", icon: "SlidersHorizontal", Component: SettingsScreen });
  client.addFilePanel({ id: "sql-file", title: "Run in Datawise", icon: "Database", files: { extensions: ["sql"] }, Component: SqlFilePanel });
  client.addFilePanel({ id: "sqlite-file", title: "SQLite in Datawise", icon: "Database", files: { extensions: ["sqlite", "sqlite3", "db"] }, Component: SqliteFilePanel });
  client.addAttachmentSource(structureAttachment);
  client.addCommandCenterItem({
    id: "open-datawise",
    title: "Open Datawise",
    icon: "Database",
    context: "global",
    onSelect({ openScreen }) {
      openScreen({ screenId: "main" });
    },
  });
  client.addCommandCenterItem({
    id: "datawise-preferences",
    title: "Datawise preferences",
    icon: "SlidersHorizontal",
    context: "global",
    onSelect({ openSettings }) {
      openSettings("preferences");
    },
  });
  return () => {};
}

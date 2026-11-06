import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { DatawiseApp } from "./client/app";

function SidebarItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return <SidebarRow icon="Database" active={currentScreen?.screenId === "main"} onPress={() => openScreen({ screenId: "main" })} />;
}

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: "main", title: "Datawise", Component: DatawiseApp });
  client.addSidebarHeaderItem({ id: "main", title: "Datawise", Component: SidebarItem });
  client.addWorkspacePanel({ id: "browser", title: "Datawise", icon: "Database", Component: DatawiseApp });
  client.addCommandCenterItem({
    id: "open-datawise",
    title: "Open Datawise",
    icon: "Database",
    context: "global",
    onSelect({ openScreen }) {
      openScreen({ screenId: "main" });
    },
  });
  return () => {};
}

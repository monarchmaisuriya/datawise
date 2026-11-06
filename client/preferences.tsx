import { useSettings } from "@getpaseo/plugin/client";
import { createContext, type ReactNode, useContext, useMemo } from "react";
import { View } from "react-native";
import { DEFAULT_PREFERENCES, type Preferences, preferencesDocument } from "../shared/preferences";

const PreferencesContext = createContext<Preferences>(DEFAULT_PREFERENCES);

export function usePreferences(): Preferences {
  return useContext(PreferencesContext);
}

// Waits for the first answer, so a table is not read once with the default page size and again with the
// saved one. A damaged document means defaults, and it never stops the app.
export function PreferencesProvider({ children }: { children: ReactNode }) {
  const settings = useSettings(preferencesDocument);
  const values = settings.status === "ready" ? settings.values : DEFAULT_PREFERENCES;
  const shown = useMemo(() => ({ ...values, nullText: values.nullText.trim() === "" ? DEFAULT_PREFERENCES.nullText : values.nullText }), [values]);
  if (settings.status === "loading") return <View style={{ flex: 1 }} />;
  return <PreferencesContext.Provider value={shown}>{children}</PreferencesContext.Provider>;
}

import { DEFAULT_PREFERENCES, type Preferences, preferencesDocument } from "../shared/preferences";

type Registered = {
  read(): Promise<{ status: string; values?: Preferences }>;
  subscribe(listener: (next: { status: string; values?: Preferences }) => void): () => void;
};

// A damaged settings document must never stop a connection, so anything but a good read means defaults.
export class PreferencesReader {
  private current: Preferences | null = null;
  private warned = false;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly settings: Registered,
    onChange: (values: Preferences) => void,
  ) {
    this.unsubscribe = settings.subscribe((next) => {
      if (next.status === "ready" && next.values) {
        this.current = next.values;
        onChange(next.values);
      }
    });
  }

  async get(): Promise<Preferences> {
    if (this.current) return this.current;
    try {
      const state = await this.settings.read();
      if (state.status === "ready" && state.values) {
        this.current = state.values;
        return state.values;
      }
    } catch {
      // The same as a document that could not be read.
    }
    if (!this.warned) {
      this.warned = true;
      console.error("Datawise: the preferences document could not be read, so defaults apply.");
    }
    return DEFAULT_PREFERENCES;
  }

  close() {
    this.unsubscribe();
  }
}

export { preferencesDocument };

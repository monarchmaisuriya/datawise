import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ZodType } from "zod";

// A small JSON file in the plugin's data folder, readable only by this user. Unlike connections.json,
// it holds nothing that cannot be rebuilt. A damaged file is set aside and work carries on from empty.
export class SideFile<T> {
  private loading: Promise<T> | null = null;
  private writes: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly findFolder: () => Promise<string>,
    private readonly name: string,
    private readonly schema: ZodType<T>,
    private readonly empty: () => NoInfer<T>,
  ) {}

  // One shared load, so two first readers cannot end up holding different objects.
  read(): Promise<T> {
    this.loading ??= this.load();
    return this.loading;
  }

  private async load(): Promise<T> {
    const path = join(await this.findFolder(), this.name);
    let raw: string | null = null;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.loading = null;
        throw error;
      }
    }
    if (raw === null) return this.empty();
    try {
      return this.schema.parse(JSON.parse(raw));
    } catch {
      console.error(`Datawise: ${this.name} could not be read, so it was set aside and starts empty.`);
      await rename(path, `${path}.damaged`).catch(() => undefined);
      return this.empty();
    }
  }

  // Writes one at a time, replacing the file in one step, so a crash leaves the old file whole.
  async update(change: (state: T) => void): Promise<void> {
    const state = await this.read();
    change(state);
    const write = this.writes.then(async () => {
      const folder = await this.findFolder();
      await mkdir(folder, { recursive: true, mode: 0o700 });
      await chmod(folder, 0o700);
      const path = join(folder, this.name);
      const temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
      await rename(temporary, path);
    });
    this.writes = write.catch(() => undefined);
    return write;
  }
}

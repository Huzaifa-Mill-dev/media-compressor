/** Snapshot undo/redo. Call checkpoint() BEFORE mutating; bursts with the same key (typing, nudging, colour
 *  dragging) collapse into one step. */
import { clone, type DocModel } from "./model";

const LIMIT = 200;
const COALESCE_MS = 1200;

export class History {
  private past: DocModel[] = [];
  private future: DocModel[] = [];
  private lastKey = "";
  private lastAt = 0;

  checkpoint(state: DocModel, key = ""): void {
    const now = Date.now();
    if (key && key === this.lastKey && now - this.lastAt < COALESCE_MS) {
      this.lastAt = now;
      return;
    }
    this.past.push(clone(state));
    if (this.past.length > LIMIT) this.past.shift();
    this.future = [];
    this.lastKey = key;
    this.lastAt = now;
  }

  /** Forget the most recent checkpoint (the change it guarded turned out to be a no-op). */
  dropLast(): void {
    this.past.pop();
    this.lastKey = "";
  }

  undo(state: DocModel): DocModel | null {
    const prev = this.past.pop();
    if (!prev) return null;
    this.future.push(clone(state));
    this.lastKey = "";
    return prev;
  }

  redo(state: DocModel): DocModel | null {
    const next = this.future.pop();
    if (!next) return null;
    this.past.push(clone(state));
    this.lastKey = "";
    return next;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }
  get canRedo(): boolean {
    return this.future.length > 0;
  }

  clear(): void {
    this.past = [];
    this.future = [];
    this.lastKey = "";
  }
}

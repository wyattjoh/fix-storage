import type { FindCulprit, ListFolder, Culprit } from "./browse";
import type { CategoryId, Root } from "./categories";
import type { Item, ScanSnapshot, StartScan } from "./scan";

/**
 * A request from the UI thread to the measuring worker.
 */
export type Request =
  | { op: "scan"; id: number; roots: Root[] }
  | { op: "list"; id: number; path: string }
  | { op: "culprit"; id: number; path: string }
  | { op: "measure"; id: number; category: CategoryId; roots: Root[] }
  | { op: "cancel"; id: number }
  | { op: "forget"; path: string | null };

/**
 * A reply from the measuring worker. Updates for one request arrive at most
 * every UPDATE_MS; "done" always follows the last update.
 */
export type Reply =
  | { type: "update"; id: number; payload: unknown }
  | { type: "done"; id: number; payload: unknown }
  | { type: "child"; pid: number; alive: boolean };

/**
 * Least time between two updates for one request, so the UI re-renders a few
 * times a second at most while a scan streams in.
 */
export const UPDATE_MS = 200;

/**
 * Folder listing as it travels between threads.
 */
export interface ListUpdate {
  items: Item[];
  current: string;
}

/**
 * Measuring that runs in a worker thread. Spawning dust and walking folders
 * would otherwise block the thread that draws the screen.
 */
export interface Measurer {
  startScan: StartScan;
  listFolder: ListFolder;
  findCulprit: FindCulprit;
  measure: (category: CategoryId, roots: Root[]) => Promise<number>;
  /**
   * Drops remembered folder sizes for a path and around it, or all of them for null.
   */
  forgetSizes: (path: string | null) => void;
  /**
   * Kills every dust process the worker started, then the worker.
   */
  stop: () => void;
}

interface Handler {
  update: (payload: unknown) => void;
  done: (payload: unknown) => void;
}

/**
 * Starts the measuring worker and returns functions that talk to it.
 */
export function startMeasurer(): Measurer {
  const worker = new Worker(new URL("./measure-worker.ts", import.meta.url).href);
  // Known here too, so they can be killed synchronously on the way out.
  const children = new Set<number>();
  const handlers = new Map<number, Handler>();
  let nextId = 1;

  worker.onmessage = (event: MessageEvent<Reply>) => {
    const reply = event.data;
    if (reply.type === "child") {
      if (reply.alive) children.add(reply.pid);
      else children.delete(reply.pid);
      return;
    }
    const handler = handlers.get(reply.id);
    if (!handler) return;
    if (reply.type === "update") return handler.update(reply.payload);
    handlers.delete(reply.id);
    handler.done(reply.payload);
  };

  const send = (request: Request) => worker.postMessage(request);
  const start = (request: Request & { id: number }, handler: Handler) => {
    handlers.set(request.id, handler);
    send(request);
    return () => send({ op: "cancel", id: request.id });
  };

  return {
    startScan(roots, onUpdate) {
      let cancel = () => {};
      const done = new Promise<ScanSnapshot>((resolve) => {
        cancel = start(
          { op: "scan", id: nextId++, roots },
          {
            update: (snapshot) => onUpdate(snapshot as ScanSnapshot),
            done: (snapshot) => {
              onUpdate(snapshot as ScanSnapshot);
              resolve(snapshot as ScanSnapshot);
            },
          },
        );
      });
      return { cancel: () => cancel(), done };
    },
    listFolder(path, onUpdate) {
      const cancel = start(
        { op: "list", id: nextId++, path },
        {
          update: (payload) => {
            const { items, current } = payload as ListUpdate;
            onUpdate(items, false, current);
          },
          done: (payload) => onUpdate((payload as ListUpdate).items, true, ""),
        },
      );
      return { cancel };
    },
    findCulprit(path, onDone) {
      const cancel = start(
        { op: "culprit", id: nextId++, path },
        { update: () => {}, done: (culprit) => onDone(culprit as Culprit) },
      );
      return { cancel };
    },
    measure(category, roots) {
      return new Promise<number>((resolve) => {
        start(
          { op: "measure", id: nextId++, category, roots },
          { update: () => {}, done: (bytes) => resolve(bytes as number) },
        );
      });
    },
    forgetSizes(path) {
      send({ op: "forget", path });
    },
    stop() {
      for (const pid of children) {
        try {
          process.kill(pid);
        } catch {
          // already gone
        }
      }
      children.clear();
      worker.terminate();
    },
  };
}

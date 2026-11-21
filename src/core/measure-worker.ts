import { findCulprit, forgetAllSizes, forgetSizes, listFolder } from "./browse";
import { UPDATE_MS, type ListUpdate, type Reply, type Request } from "./measurer";
import { measure, startScan, watchChildren } from "./scan";

declare const self: Worker;

const post = (reply: Reply) => self.postMessage(reply);
watchChildren((pid, alive) => post({ type: "child", pid, alive }));

const cancels = new Map<number, () => void>();

/**
 * Holds the newest update for a request and sends it at most every UPDATE_MS.
 * finish() sends any held update, then "done".
 */
function updates(id: number) {
  let held: { payload: unknown } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let last = 0;
  const flush = () => {
    timer = null;
    if (!held) return;
    last = Date.now();
    post({ type: "update", id, payload: held.payload });
    held = null;
  };
  return {
    push(payload: unknown) {
      held = { payload };
      if (!timer) timer = setTimeout(flush, Math.max(0, UPDATE_MS - (Date.now() - last)));
    },
    finish(payload: unknown) {
      if (timer) clearTimeout(timer);
      held = null;
      timer = null;
      cancels.delete(id);
      post({ type: "done", id, payload });
    },
  };
}

self.onmessage = (event: MessageEvent<Request>) => {
  const request = event.data;
  switch (request.op) {
    case "scan": {
      const out = updates(request.id);
      const handle = startScan(request.roots, (snapshot) => out.push(snapshot), {
        throttleMs: UPDATE_MS / 2,
      });
      cancels.set(request.id, () => handle.cancel());
      void handle.done.then((snapshot) => out.finish(snapshot));
      return;
    }
    case "list": {
      const out = updates(request.id);
      const handle = listFolder(request.path, (items, done, current) => {
        if (done) out.finish({ items, current } satisfies ListUpdate);
        else out.push({ items, current } satisfies ListUpdate);
      });
      cancels.set(request.id, () => handle.cancel());
      return;
    }
    case "culprit": {
      const out = updates(request.id);
      const handle = findCulprit(request.path, (culprit) => out.finish(culprit));
      cancels.set(request.id, () => handle.cancel());
      return;
    }
    case "measure": {
      const out = updates(request.id);
      void measure(request.category, request.roots).then((bytes) => out.finish(bytes));
      return;
    }
    case "cancel":
      cancels.get(request.id)?.();
      cancels.delete(request.id);
      return;
    case "forget":
      if (request.path === null) forgetAllSizes();
      else forgetSizes(request.path);
      return;
  }
};

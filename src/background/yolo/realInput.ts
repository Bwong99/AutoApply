// Real input for YOLO through Chrome's debugger: on a page a bot check grades, the mouse and keys it sees come from
// the browser (isTrusted), not from page script. Chrome shows "AutoApply started debugging this browser" while
// attached, so a tab is attached only for the moments it is clicked or typed in, and let go 3 s after.
import type { RealOp } from "../../shared/messages";

const IDLE_MS = 3000;

interface Session {
  /** Where the pointer last was, for the next path. */
  x: number;
  y: number;
  idle?: ReturnType<typeof setTimeout>;
}
const sessions = new Map<number, Promise<Session>>();
/** Tabs whose debugging bar the user cancelled: never attached to again. */
const refused = new Set<number>();
let listening = false;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const between = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
const cdp = (tabId: number, method: string, params?: Record<string, unknown>) =>
  chrome.debugger.sendCommand({ tabId }, method, params);

function attach(tabId: number): Promise<Session> {
  let s = sessions.get(tabId);
  if (!s) {
    // Read only now, so a worker that never uses real input never registers these.
    if (!listening) {
      listening = true;
      chrome.debugger.onDetach.addListener(({ tabId: id }, reason) => {
        if (id === undefined) return;
        sessions.delete(id);
        if (reason === "canceled_by_user") refused.add(id);
      });
      chrome.tabs.onRemoved.addListener((id) => refused.delete(id));
    }
    s = (async () => {
      await chrome.debugger.attach({ tabId }, "1.3").catch((e: Error) => {
        // Still attached from a worker that stopped meanwhile.
        if (!/already attached/i.test(e.message)) throw e;
      });
      // A click or key in a page without focus is no person's: it reads as focused while attached.
      await cdp(tabId, "Emulation.setFocusEmulationEnabled", { enabled: true });
      return { x: between(300, 700), y: between(200, 450) };
    })();
    sessions.set(tabId, s);
    s.catch(() => sessions.delete(tabId));
  }
  return s;
}

function release(tabId: number, s: Session) {
  s.idle = setTimeout(() => {
    sessions.delete(tabId);
    void chrome.debugger.detach({ tabId }).catch(() => undefined);
  }, IDLE_MS);
}

/** A hand's path: eased in and out along a slight arc, a point every 8–20 ms. */
async function moveTo(tabId: number, s: Session, x: number, y: number) {
  const dx = x - s.x;
  const dy = y - s.y;
  const steps = Math.round(Math.max(8, Math.min(30, Math.hypot(dx, dy) / 25)));
  const bend = between(-0.15, 0.15);
  for (let i = 1; i <= steps; i++) {
    const p = i / steps;
    const e = p * p * (3 - 2 * p);
    const arc = bend * Math.sin(Math.PI * p);
    await cdp(tabId, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: s.x + dx * e - dy * arc,
      y: s.y + dy * e + dx * arc,
    });
    await wait(between(8, 20));
  }
  s.x = x;
  s.y = y;
}

async function perform(tabId: number, s: Session, op: RealOp) {
  if (op.kind !== "type") {
    await moveTo(tabId, s, op.x, op.y);
    if (op.kind === "move") return wait(between(150, 400));
    const at = { x: op.x, y: op.y, button: "left", clickCount: 1 };
    await wait(between(60, 160));
    await cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", buttons: 1, ...at });
    await wait(between(50, 120));
    await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", buttons: 0, ...at });
    return;
  }
  // A long answer or one with line breaks goes in at once, as a person pastes an essay; a short one key by key.
  if (op.text.length > 60 || /\n/.test(op.text)) return void (await cdp(tabId, "Input.insertText", { text: op.text }));
  for (const ch of op.text) {
    const keyCode = /^[a-z0-9]$/i.test(ch) ? ch.toUpperCase().charCodeAt(0) : 0;
    await cdp(tabId, "Input.dispatchKeyEvent", {
      type: "keyDown",
      key: ch,
      text: ch,
      unmodifiedText: ch,
      windowsVirtualKeyCode: keyCode,
    });
    await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key: ch, windowsVirtualKeyCode: keyCode });
    await wait(between(30, 90));
  }
}

/** Performs `op` in the tab for real. False when it can't: no debugger, or the user cancelled the debugging bar. */
export async function realInput(tabId: number, op: RealOp): Promise<boolean> {
  // The namespace reads undefined in a dead extension context.
  if (!chrome.debugger || refused.has(tabId)) return false;
  try {
    const s = await attach(tabId);
    clearTimeout(s.idle);
    try {
      await perform(tabId, s, op);
    } finally {
      release(tabId, s);
    }
    return true;
  } catch {
    return false;
  }
}

/** Whether real input can run in this worker. */
export const realInputReady = () => !!chrome.debugger;

/** Stop all trusted input before a review tab belongs to the user. */
export async function releaseRealInput(tabId: number) {
  const pending = sessions.get(tabId);
  sessions.delete(tabId);
  const s = await pending?.catch(() => null);
  if (s) clearTimeout(s.idle);
  if (chrome.debugger) await chrome.debugger.detach({ tabId }).catch(() => undefined);
}

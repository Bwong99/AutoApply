// Where YOLO loads job pages: an iframe in an offscreen document (nothing on screen), else a background tab.
import { compiling, releaseOffscreen, useOffscreen } from "../offscreen";

const RULE = 9001;

/**
 * Lets sites load inside the offscreen document's frame: their X-Frame-Options / CSP frame-ancestors forbid
 * embedding. Limited to frames outside any tab, i.e. ours, and only while the host is open.
 */
const unframeRule = (): chrome.declarativeNetRequest.Rule => ({
  id: RULE,
  priority: 1,
  action: {
    type: "modifyHeaders" as chrome.declarativeNetRequest.RuleActionType,
    responseHeaders: ["x-frame-options", "content-security-policy"].map((header) => ({
      header,
      operation: "remove" as chrome.declarativeNetRequest.HeaderOperation,
    })),
  },
  condition: {
    tabIds: [chrome.tabs.TAB_ID_NONE],
    resourceTypes: ["sub_frame" as chrome.declarativeNetRequest.ResourceType],
  },
});

export async function openFrame(url: string) {
  // Also when the document is already open: a résumé compile may have opened it, without the rule.
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [RULE], addRules: [unframeRule()] });
  await useOffscreen("yolo");
  await chrome.runtime.sendMessage({ type: "YOLO_HOST_NAVIGATE", url });
}

/** Frees the hidden page's renderer once the queue is empty (a compile in progress keeps the document, not the page). */
export async function closeFrame() {
  if (compiling()) await chrome.runtime.sendMessage({ type: "YOLO_HOST_CLEAR" }).catch(() => undefined);
  await releaseOffscreen("yolo");
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [RULE] });
}

/** A tab for pages that won't work hidden (inactive, in a collapsed group), or a visible one for the user. */
export async function openTab(url: string, visible: boolean): Promise<number> {
  const tab = await chrome.tabs.create({ url, active: visible });
  if (!visible && tab.id !== undefined) {
    const groupId = await chrome.tabs.group({ tabIds: tab.id });
    await chrome.tabGroups.update(groupId, { title: "AutoApply", collapsed: true });
  }
  return tab.id!;
}

export const closeTab = (id: number) => chrome.tabs.remove(id).catch(() => undefined);

/**
 * Renders `url` in an inactive tab in the collapsed AutoApply group, as a first-party page with the user's session,
 * window and headers (so a bot check can pass by itself), and returns the first non-null answer of `read` in its page,
 * asked each second; null after `timeoutMs`. Outside YOLO's run: no driver, and the tab is closed either way.
 */
export async function readInTab<T>(url: string, read: () => T | null, timeoutMs = 30_000): Promise<T | null> {
  const tabId = await openTab(url, false);
  try {
    for (const end = Date.now() + timeoutMs; Date.now() < end;) {
      await new Promise((r) => setTimeout(r, 1000));
      // Fails while the page navigates (a passed check reloads it); asked again a second later.
      const [hit] = await chrome.scripting.executeScript({ target: { tabId }, func: read }).catch(() => []);
      if (hit?.result != null) return hit.result as T;
    }
    return null;
  } finally {
    await closeTab(tabId);
  }
}

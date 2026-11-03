// §11.7 per-tab job context in chrome.storage.session.
import { session } from "../shared/storage";
import type { JobContext, Pay } from "../shared/types";

const MAX_AGE = 2 * 3600 * 1000;
const fresh = (c: JobContext | null): c is JobContext => !!c && Date.now() - c.capturedAt < MAX_AGE;

/** `pageUrl`: the tab's address, for a context sent by a child frame. */
export async function setJobContext(tabId: number, ctx: JobContext, pageUrl?: string): Promise<void> {
  const prev = await getJobContext(tabId);
  // An embedded form's frame adds its description to the page's job: Block's Greenhouse frame replaced the page's
  // company and location with "job-boards" and none, and work authorization went to the model blind.
  if (pageUrl !== undefined) {
    const page = prev?.url === pageUrl;
    return session.setJobContext(tabId, page ? { ...prev, text: ctx.text || prev.text } : { ...ctx, embedded: true });
  }
  // A page without a description (e.g. step 2 of an application) keeps the earlier description.
  if (!ctx.text && prev?.text) {
    if (prev.embedded) await session.setJobContext(tabId, { ...ctx, text: prev.text });
    // Borrowed from a job board, which names itself as the company: the employer's site knows better.
    else if (prev.borrowed && new URL(ctx.url).host !== new URL(prev.url).host)
      await session.setJobContext(tabId, { ...ctx, text: prev.text, location: ctx.location || prev.location });
    return;
  }
  await session.setJobContext(tabId, ctx);
}

/**
 * The posting of the tab that opened this one, for an application with no description of its own (a job board's
 * "Apply" opening the employer's form in a new tab). Pinned to this tab, as the job board moves on to other jobs.
 */
export async function adoptPosting(tabId: number, posting: JobContext | null): Promise<void> {
  if (posting?.text && !(await session.getJobContext(tabId))?.text)
    await session.setJobContext(tabId, { ...posting, borrowed: true });
}

export async function getJobContext(tabId: number): Promise<JobContext | null> {
  const c = await session.getJobContext(tabId);
  return fresh(c) ? c : null;
}

/** A posting read on `tab`: a page with no pay listed clears the last posting's, not pay a frame of it found. */
export async function setJobPay(tab: chrome.tabs.Tab, pays: Pay[]): Promise<void> {
  if (tab.id === undefined) return;
  const url = tab.url ?? "";
  const prev = await session.getJobPay(tab.id);
  if (!pays.length && prev?.url === url && prev.pays.length) return;
  await session.setJobPay(tab.id, { pays, url, at: Date.now() });
}

/**
 * The pay of the posting this tab last showed, else of the tab that opened it (an "Apply" link opening a new tab, a
 * company's site without the job board's pay) while that tab still shows the same page: one navigated to another
 * job no longer speaks for this one.
 */
export async function getJobPay(tab: chrome.tabs.Tab): Promise<Pay[]> {
  const fresh = (p: { at: number } | null) => !!p && Date.now() - p.at < MAX_AGE;
  const own = tab.id === undefined ? null : await session.getJobPay(tab.id);
  if (fresh(own) && own!.pays.length) return own!.pays;
  if (tab.openerTabId === undefined) return [];
  const [rec, opener] = await Promise.all([
    session.getJobPay(tab.openerTabId),
    chrome.tabs.get(tab.openerTabId).catch(() => null),
  ]);
  return fresh(rec) && opener?.url === rec!.url ? rec!.pays : [];
}

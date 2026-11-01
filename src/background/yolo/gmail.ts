// Sites' verification emails (links and one-time codes), read from the YOLO inbox with the Gmail API, read-only.
import { EMAIL_WAIT_MS, SLEPT_MS } from "../../shared/constants";
import { session } from "../../shared/storage";

export class GmailAuthError extends Error {}

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

/** An access token for the YOLO inbox; `interactive` shows Google's sign-in, else it renews silently or throws. */
export async function gmailToken(clientId: string, email: string, interactive: boolean): Promise<string> {
  const cached = await session.get<{ token: string; exp: number }>("gmailToken");
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;
  if (!clientId) throw new GmailAuthError("Gmail isn't connected");
  const url = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
    client_id: clientId,
    response_type: "token",
    redirect_uri: chrome.identity.getRedirectURL(),
    scope: "https://www.googleapis.com/auth/gmail.readonly",
    login_hint: email,
    ...(interactive ? {} : { prompt: "none" }),
  })}`;
  const back = await chrome.identity
    .launchWebAuthFlow({ url, interactive, ...(interactive ? {} : { timeoutMsForNonInteractive: 10_000 }) })
    .catch((e: Error) => {
      throw new GmailAuthError(e.message);
    });
  const h = new URLSearchParams(new URL(back ?? "about:blank").hash.slice(1));
  const token = h.get("access_token");
  if (!token) throw new GmailAuthError(h.get("error") ?? "Gmail sign-in failed");
  await session.set("gmailToken", { token, exp: Date.now() + Number(h.get("expires_in") ?? 3600) * 1000 });
  return token;
}

/** Throws GmailAuthError when the YOLO inbox can't be read without the user (access revoked, sign-in expired). */
export async function checkGmail(clientId: string, email: string): Promise<void> {
  const r = await fetch(`${API}/profile`, {
    headers: { authorization: `Bearer ${await gmailToken(clientId, email, false)}` },
  });
  if (r.status !== 401) return;
  await session.remove("gmailToken");
  throw new GmailAuthError("Gmail sign-in expired");
}

interface Part {
  mimeType?: string;
  body?: { data?: string };
  parts?: Part[];
}

const fromB64url = (s: string) =>
  new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)));

export function bodyOf(p: Part): string {
  const own = /^text\/(html|plain)/.test(p.mimeType ?? "") && p.body?.data ? fromB64url(p.body.data) : "";
  return [own, ...(p.parts ?? []).map(bodyOf)].join("\n");
}

const RE_LINK = /verif|activat|confirm|validat|token|registr|reset|password|signup|sign-up|account/i;
const RE_NOT_LINK =
  /unsubscribe|privacy|terms|preferences|support|help|facebook|twitter|linkedin|instagram|youtube|\.(png|jpe?g|gif)\b/i;

/** The site a host belongs to: its registrable domain (approximately: no public suffix list). Workday's are one. */
export function siteOf(host: string): string {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (/(^|\.)myworkday(jobs|site)?\.com$/.test(h)) return "myworkday.com";
  const p = h.split(".");
  // "co.uk", "com.au": a short label under a country code
  const n = p.length > 2 && p.at(-1)!.length === 2 && p.at(-2)!.length <= 3 ? 3 : 2;
  return p.slice(-n).join(".");
}

export const siteOfUrl = (u: string) => {
  try {
    return siteOf(new URL(u).hostname);
  } catch {
    return "";
  }
};

/** Email services' click tracking: its links hide where they lead, so the run checks where it landed (YOLO_STEP). */
const TRACKERS = new Set([
  "sendgrid.net",
  "mailgun.org",
  "mandrillapp.com",
  "awstrack.me",
  "sparkpostmail.com",
  "list-manage.com",
]);
const RE_LINK_TEXT = /verif|activat|confirm|validat/i;

/**
 * The verification link or one-time code in an email body. A link only on one of `sites` (the run's), else wrapped in
 * a known click tracker behind a "Verify"/"Confirm" button: an email can't send the run anywhere else.
 */
export function extract(body: string, want: "link" | "code", sites?: string[]): string | null {
  if (want === "link") {
    const links = [
      ...[...body.matchAll(/<a\b[^>]*?\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)].map((m) => [m[1], m[2]]),
      ...[...body.matchAll(/https?:\/\/[^\s"'<>]+/g)].map((m) => [m[0], ""]),
    ]
      .map(([u, text]) => ({ url: u.replace(/&amp;/g, "&"), text: text.replace(/<[^>]+>/g, " "), site: siteOfUrl(u) }))
      .filter((l) => /^https?:/.test(l.url) && !RE_NOT_LINK.test(l.url));
    const own = links.find((l) => RE_LINK.test(l.url) && (!sites || sites.includes(l.site)));
    const tracked = links.find((l) => TRACKERS.has(l.site) && RE_LINK_TEXT.test(l.text) && !RE_NOT_LINK.test(l.text));
    return (own ?? tracked)?.url ?? null;
  }
  const t = body
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ");
  // Letters and digits with a digit somewhere: a code, not the word after "code".
  return (
    /\b(?:code|passcode|pin|otp)\b[\s\S]{0,80}?\b(\d{4,8}|(?=[A-Za-z]*\d)[A-Za-z0-9]{6,10})\b/i.exec(t)?.[1] ??
    /\b(\d{6})\b/.exec(t)?.[1] ??
    null
  );
}

/** Messages in Gmail's unread-mail feed for `to` received after `since`, as their subject and opening text. */
export function feedTexts(xml: string, to: string, since: number): string[] | null {
  const account = to.toLowerCase().replace(/\+[^@]*@/, "@");
  if (!xml.toLowerCase().includes(account)) return null; // another signed-in account's inbox
  const unxml = (s: string) =>
    s
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&");
  return xml
    .split("<entry>")
    .slice(1)
    .filter((e) => Date.parse(/<issued>([^<]+)/.exec(e)?.[1] ?? "") >= since - 60_000)
    .map((e) => unxml(`${/<title>([^<]*)/.exec(e)?.[1] ?? ""} ${/<summary>([^<]*)/.exec(e)?.[1] ?? ""}`));
}

/**
 * Without a Gmail API client: a code from the unread-mail feed of the Gmail account signed in to this browser. Only
 * codes: the feed holds each message's subject and opening text, not its links.
 */
export async function waitForFeedCode(to: string, since: number, timeoutMs = EMAIL_WAIT_MS): Promise<string | null> {
  for (let end = Date.now() + timeoutMs; Date.now() < end; end += await nap()) {
    for (let u = 0; u < 5; u++) {
      const r = await fetch(`https://mail.google.com/mail/u/${u}/feed/atom`, { credentials: "include" }).catch(
        () => null,
      );
      if (!r?.ok) break;
      const texts = feedTexts(await r.text(), to, since);
      if (!texts) continue;
      const code = texts.map((t) => extract(t, "code")).find(Boolean);
      if (code) return code;
      break;
    }
  }
  return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The wait between inbox checks. Returns how long the computer slept meanwhile, which the wait doesn't count, and then
 * gives the network up to 2 minutes to come back before the next check.
 */
async function nap(): Promise<number> {
  const t = Date.now();
  await sleep(10_000);
  const slept = Date.now() - t - 10_000;
  if (slept < SLEPT_MS) return 0;
  for (let i = 0; i < 24 && !navigator.onLine; i++) await sleep(5000);
  return Date.now() - t - 10_000;
}

/** Polls the inbox for a message to `to` received after `since` that holds what `want`s (a link for `sites`); null after 5 minutes. */
export async function waitForEmail(
  token: () => Promise<string>,
  to: string,
  since: number,
  want: "link" | "code",
  sites: string[],
  timeoutMs = EMAIL_WAIT_MS,
): Promise<string | null> {
  const api = async <T>(path: string): Promise<T> => {
    const r = await fetch(`${API}/${path}`, { headers: { authorization: `Bearer ${await token()}` } });
    if (r.status === 401) throw new GmailAuthError("Gmail sign-in expired");
    if (!r.ok) throw new Error(`Gmail HTTP ${r.status}`);
    return r.json() as Promise<T>;
  };
  const tried = new Set<string>();
  for (let end = Date.now() + timeoutMs; Date.now() < end; end += await nap()) {
    const q = `to:${to} after:${Math.floor(since / 1000) - 120}`;
    const list = await api<{ messages?: { id: string }[] }>(`messages?maxResults=10&q=${encodeURIComponent(q)}`);
    for (const { id } of list.messages ?? []) {
      if (tried.has(id)) continue;
      tried.add(id);
      const m = await api<{ internalDate: string; payload: Part }>(`messages/${id}?format=full`);
      if (Number(m.internalDate) < since - 60_000) continue;
      const found = extract(bodyOf(m.payload), want, sites);
      if (found) return found;
    }
  }
  return null;
}

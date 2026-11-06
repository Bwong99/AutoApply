// Playwright route handler that fakes the Gemini REST API. Decisions are deterministic, keyed by field label.
import type { BrowserContext, Route } from "@playwright/test";
import { canonicalCountry, canonicalRegion } from "../src/shared/constants";
import { normalize } from "../src/shared/normalize";

type Json = Record<string, unknown>;
export type CallKind =
  | "list"
  | "validate"
  | "map"
  | "audit"
  | "choose"
  | "essay"
  | "resume"
  | "guess"
  | "relevance"
  | "tailor"
  | "review"
  | "navigate";
export interface Call {
  kind: CallKind;
  key: string;
  model: string;
  status: number;
  payload?: Json;
}
interface Field {
  id: string;
  kind: string;
  label: string;
  options?: string[];
  optionsKnown?: boolean;
  section?: string;
  placeholder?: string;
}

/** Jobs of a test profile that has them; "Work Experience N" fields answer from the Nth. */
export const EXPERIENCE = [
  {
    company: "Analytical Engines Ltd",
    title: "Software Engineer Intern",
    startDate: "2026-01",
    endDate: "2026-08",
    current: false,
    description: "Built analytics tooling.",
  },
  {
    company: "Babbage & Co",
    title: "IT Technician Intern",
    startDate: "2023-06",
    endDate: "2023-08",
    current: false,
    description: "Kept the lab running.",
  },
];

export const MODELS = [
  "embedding-001",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.5-pro",
  "gemini-2.5-flash-preview-tts",
  "gemma-3-27b-it",
  "gemini-flash-latest",
];

const err = (code: number, status: string, message: string, details: unknown[] = []) => ({
  error: { code, status, message, details },
});

/** Canned failure bodies matching the real API's shape. */
export const FAILURES = {
  perMinute: {
    status: 429,
    body: err(429, "RESOURCE_EXHAUSTED", "You exceeded your current quota.", [
      {
        "@type": "type.googleapis.com/google.rpc.QuotaFailure",
        violations: [{ quotaId: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier", quotaValue: "15" }],
      },
      { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "30s" },
    ]),
  },
  daily: {
    status: 429,
    body: err(429, "RESOURCE_EXHAUSTED", "You exceeded your current quota.", [
      {
        "@type": "type.googleapis.com/google.rpc.QuotaFailure",
        violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier", quotaValue: "1000" }],
      },
    ]),
  },
  limitZero: {
    status: 429,
    body: err(429, "RESOURCE_EXHAUSTED", "Quota exceeded for metric: generate_content_free_tier_requests, limit: 0"),
  },
  unavailable: { status: 503, body: err(503, "UNAVAILABLE", "The model is overloaded. Please try again later.") },
  invalidKey: {
    status: 400,
    body: err(400, "INVALID_ARGUMENT", "API key not valid. Please pass a valid API key.", [
      { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID" },
    ]),
  },
};

type Failure = { status: number; body: unknown };

const unnumber = (o: string) => o.replace(/^\d+: /, "");

/** "Vancouver, British Columbia, Canada" means "Vancouver, BC, Canada", part by part. */
function samePlace(a: string, b: string): boolean {
  const [x, y] = [a.split(","), b.split(",")];
  const same = (p: string, q: string) =>
    normalize(p) === normalize(q) || [canonicalRegion, canonicalCountry].some((c) => c(p) !== null && c(p) === c(q));
  return x.length === y.length && x.every((p, k) => same(p, y[k]));
}

const pick = (f: Field, re: RegExp) => {
  const i = (f.options ?? []).findIndex((o) => re.test(unnumber(o)));
  return i >= 0 ? [i] : null;
};

/** Label → decision table standing in for the model's semantic judgement. */
function decide(f: Field): Json {
  const L = f.label;
  const fill = (extra: Json) => ({
    fieldId: f.id,
    action: "fill",
    confidence: "high",
    sources: ["personal.address"],
    ...extra,
  });
  const choose = (re: RegExp, source: string) => {
    const idx = pick(f, re);
    return idx
      ? fill({ optionIndexes: idx, sources: [source] })
      : { fieldId: f.id, action: "flag", confidence: "low", note: "No option" };
  };
  const nth = /^Work Experience (\d+)$/.exec(f.section ?? "")?.[1];
  if (nth) {
    const job = EXPERIENCE[Number(nth) - 1];
    const asked = `${L} ${f.placeholder ?? ""}`;
    const text = /company|employer/i.test(asked)
      ? job?.company
      : /title/i.test(asked)
        ? job?.title
        : /summary|description/i.test(asked)
          ? job?.description
          : undefined;
    return text ? fill({ text, sources: ["experience"] }) : { fieldId: f.id, action: "skip", confidence: "high" };
  }
  if (/relocat/i.test(L)) return choose(/^i am willing/i, "preferences.willingToRelocate");
  if (/sponsor/i.test(L)) return choose(/will not require/i, "workAuthorization.entries.requiresSponsorshipNow");
  if (/gender/i.test(L)) return choose(/don.t wish|decline|prefer not/i, "demographics.gender");
  if (/authorized to work/i.test(L)) return choose(/^yes$/i, "workAuthorization.entries.authorized");
  if (/province/i.test(L)) return choose(/british columbia/i, "personal.address.region");
  if (/country/i.test(L))
    return f.options?.length ? choose(/^canada\b/i, "personal.address.country") : fill({ intendedAnswer: "Canada" });
  if (/employment type/i.test(L)) return fill({ intendedAnswer: "Co-op", sources: ["preferences.employmentTypes"] });
  if (/^school/i.test(L))
    return fill({ intendedAnswer: "University of British Columbia", sources: ["education.school"] });
  if (/location/i.test(L)) return fill({ intendedAnswer: "Vancouver, BC, Canada", searchQuery: "Vancouver" });
  if (/18 years|18 or older/i.test(L)) return choose(/^yes$/i, "workAuthorization.over18");
  if (/work arrangement/i.test(L)) return choose(/^hybrid$/i, "preferences.workArrangement");
  if (/remote/i.test(L)) return fill({ checked: true, sources: ["preferences.workArrangement"] });
  if (/why|tell us|describe|cover letter/i.test(L)) return { fieldId: f.id, action: "essay", confidence: "high" };
  if (/agree|certify|terms|privacy/i.test(L))
    return { fieldId: f.id, action: "consent", checked: true, confidence: "high" };
  return { fieldId: f.id, action: "flag", confidence: "low", note: "Not in profile" };
}

function essay(item: Json): string {
  const words = Number(item.maxWords) || Number(item.targetWords) || 60;
  const sentence = "I build reliable software and enjoy learning from experienced teammates.";
  const out: string[] = [];
  while ((out.join(" ") + " " + sentence).split(/\s+/).length <= words) out.push(sentence);
  return out.join(" ") || sentence.split(" ").slice(0, words).join(" ");
}

const reply = (obj: unknown) => ({
  candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(obj) }] } }],
});

export class MockGemini {
  calls: Call[] = [];
  /** Failures to return, keyed by API key; each entry is consumed once. Use "*" for any key. */
  failures: Record<string, Failure[]> = {};
  /** Persistent failure for (model, key) pairs, e.g. every call to the primary model. */
  always: ((key: string, model: string, kind: CallKind) => Failure | null) | null = null;
  delayMs = 0;
  /** The résumé tailor's edit operations; by default, the first bullet group reversed and its first bullet reworded. */
  tailorOps: ((payload: Json) => Json) | null = null;
  navigation: ((payload: Json) => Json) | null = null;

  /**
   * The AI review: every field "ok", except the profile's names and email shown wrong ("wrong" with the profile's),
   * and Yes/No pills or boxes the scan missed ("missed"). Their answers come from the normal fill pipeline.
   */
  review(payload: Json): Json {
    const want: [RegExp, string][] = [
      [/^first name/i, "Ada"],
      [/^last name/i, "Lovelace"],
      [/^e-?mail/i, "ada@example.com"],
    ];
    const fields = (payload.fields as { id: string; question: string; shown: string; locked?: boolean }[]).map((f) => {
      const w = !f.locked && want.find(([re]) => re.test(f.question));
      return w && f.shown !== w[1]
        ? { fieldId: f.id, verdict: f.shown ? "wrong" : "fill", answer: w[1], reason: "Profile", sources: ["personal"] }
        : { fieldId: f.id, verdict: "ok", sources: [] };
    });
    const missed: Json[] = [];
    const lines = String(payload.page).split("\n");
    lines.forEach((line, i) => {
      const pills = [...line.matchAll(/\[(c\d+) clickable "(Yes|No)"\]/g)];
      const boxes = [...line.matchAll(/\[(c\d+) [a-z]+ unscanned[^\]]*\]/g)];
      const question = (line.replace(/\[[^\]]*\]/g, "").trim() || lines[i - 1] || "").replace(/^#\s*/, "");
      if (pills.length >= 2) {
        missed.push({
          refs: pills.map((p) => p[1]),
          question,
          kind: "radio_group",
          required: true,
        });
      } else for (const b of boxes) missed.push({ refs: [b[1]], question, kind: "text", required: false });
    });
    return { fields, missed, reveal: [] };
  }

  fail(key: string, ...f: Failure[]) {
    (this.failures[key] ??= []).push(...f);
  }

  calls_(kind: CallKind) {
    return this.calls.filter((c) => c.kind === kind && c.status === 200);
  }

  async install(ctx: BrowserContext) {
    await ctx.route("https://generativelanguage.googleapis.com/**", (r) => this.handle(r));
  }

  private async handle(route: Route) {
    const req = route.request();
    const url = new URL(req.url());
    const key = req.headers()["x-goog-api-key"] ?? "";
    if (url.searchParams.has("key")) throw new Error("API key must never be sent in the URL");
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    const send = (status: number, body: unknown, call: Omit<Call, "status">) => {
      this.calls.push({ ...call, status });
      return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    };

    if (req.method() === "GET") {
      const models = MODELS.map((m) => ({
        name: `models/${m}`,
        displayName: m,
        supportedGenerationMethods: m.startsWith("embedding") ? ["embedContent"] : ["generateContent"],
      }));
      return send(200, { models }, { kind: "list", key, model: "" });
    }

    const model = /models\/([^:]+):generateContent/.exec(url.pathname)?.[1] ?? "";
    const body = req.postDataJSON() as Json;
    const system = ((body.systemInstruction as Json)?.parts as Json[])?.[0]?.text as string;
    const text = (((body.contents as Json[])[0] as Json).parts as Json[])[0].text as string;
    const kind: CallKind = system.startsWith("Reply with")
      ? "validate"
      : system.startsWith("You fill out")
        ? "map"
        : system.startsWith("You select options")
          ? "choose"
          : system.startsWith("You write answers")
            ? "essay"
            : system.startsWith("You audit")
              ? "audit"
              : system.startsWith("You complete the fields")
                ? "guess"
                : system.startsWith("You screen job postings")
                  ? "relevance"
                  : system.startsWith("You tailor")
                    ? "tailor"
                    : system.startsWith("You review")
                      ? "review"
                      : system.startsWith("You navigate")
                        ? "navigate"
                        : "resume";
    const payload = kind === "resume" ? { text } : (JSON.parse(text) as Json);
    const call = { kind, key, model, payload };
    const gc = body.generationConfig as Json;
    if ("temperature" in gc || "topP" in gc || "topK" in gc)
      return send(400, err(400, "INVALID_ARGUMENT", "sampling params sent"), call);

    const queued = this.failures[key]?.shift() ?? this.failures["*"]?.shift();
    if (queued) return send(queued.status, queued.body, call);
    const persistent = this.always?.(key, model, kind);
    if (persistent) return send(persistent.status, persistent.body, call);

    if (kind === "validate") return send(200, reply({ ok: true }), call);
    if (kind === "map") return send(200, reply({ decisions: (payload.fields as Field[]).map(decide) }), call);
    // The decision table above only answers from the profile: every fill it makes is supported.
    if (kind === "audit") {
      const verdicts = (payload.items as { fieldId: string }[]).map((i) => ({ fieldId: i.fieldId, supported: true }));
      return send(200, reply({ verdicts }), call);
    }
    if (kind === "choose") {
      const items = payload.items as { fieldId: string; intendedAnswer: string; options: string[] }[];
      const choices = items.map((i) => {
        const idx = i.options.findIndex(
          (o) =>
            unnumber(o).toLowerCase().includes(i.intendedAnswer.toLowerCase()) ||
            samePlace(i.intendedAnswer, unnumber(o)),
        );
        return { fieldId: i.fieldId, optionIndexes: idx >= 0 ? [idx] : null, confidence: idx >= 0 ? "high" : "low" };
      });
      return send(200, reply({ choices }), call);
    }
    // YOLO's best guess: "No" where offered, else the first real option, else a short answer.
    if (kind === "guess") {
      const decisions = (payload.fields as Field[]).map((f) => ({
        fieldId: f.id,
        action: "fill",
        confidence: "medium",
        sources: ["guess"],
        ...(f.kind === "checkbox"
          ? { checked: true }
          : f.options?.length
            ? { optionIndexes: pick(f, /^no\b/i) ?? pick(f, /^(?!select|choose|--)/i) ?? [0] }
            : { text: "N/A" }),
      }));
      return send(200, reply({ decisions }), call);
    }
    if (kind === "tailor") {
      const groups = payload.groups as { group: string; items: string[] }[];
      const bullets = groups.find((g) => /\.R\d+$/.test(g.group));
      const ops = this.tailorOps?.(payload) ?? {
        edits: bullets
          ? [{ id: bullets.items[0], text: "\\resumeItem{Built TypeScript services for robot fleets}" }]
          : [],
        add: [],
        remove: [],
        order: bullets ? [{ group: bullets.group, items: [...bullets.items].reverse() }] : [],
      };
      return send(200, reply(ops), call);
    }
    if (kind === "review") return send(200, reply(this.review(payload)), call);
    // The navigator: the way in a posting words oddly ("Begin your journey"), else no way on.
    if (kind === "navigate") {
      if (this.navigation) return send(200, reply(this.navigation(payload)), call);
      const ref = /\[(c\d+) link "Begin your journey[^"]*"/.exec(String(payload.page))?.[1];
      return send(
        200,
        reply(
          ref
            ? {
                state: "posting",
                action: "click",
                ref,
                purpose: "open_application",
                reason: "The way into the application",
              }
            : { state: "other", action: "stop", reason: "No way on" },
        ),
        call,
      );
    }
    if (kind === "relevance")
      return send(200, reply({ keep: (payload.jobs as { i: number }[]).map((j) => j.i) }), call);
    if (kind === "essay")
      return send(
        200,
        reply({ essays: (payload.items as Json[]).map((i) => ({ fieldId: i.fieldId, text: essay(i) })) }),
        call,
      );
    return send(200, reply({ personal: { firstName: "Ada", lastName: "Lovelace" } }), call);
  }
}

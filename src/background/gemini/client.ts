// Gemini REST client: generateContent + models.list via fetch, with key rotation (§10.1, §10.5).
import { GEMINI_BASE } from "../../shared/constants";
import type { ApiKeyEntry, ModelCaps, ThinkingCap } from "../../shared/types";
import { essayThinking, isFresh, nextThinking, reviewThinking, THINKING_CHAIN, thinkingConfig } from "./capabilities";
import {
  AllKeysExhaustedError,
  BadOutputError,
  BadRequestError,
  BlockedError,
  classify,
  ModelGoneError,
  NoKeysError,
  ServerError,
} from "./errors";
import type { KeyPool } from "./keyPool";
import type { ApiModel } from "./models";
import { VALIDATION_PROMPT } from "./prompts";
import { VALIDATION_SCHEMA } from "./schemas";

export interface HttpResult {
  status: number;
  body: unknown;
}

/** One HTTP call. Status 0 = network error or timeout. Throws only when `signal` aborts. */
export async function httpJson(
  url: string,
  key: string,
  init: { method: "GET" | "POST"; body?: unknown },
  timeoutMs: number,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<HttpResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener("abort", onAbort);
  try {
    const res = await fetchImpl(url, {
      method: init.method,
      headers: { "x-goog-api-key": key, ...(init.body ? { "content-type": "application/json" } : {}) },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // non-JSON error bodies are classified by status
    }
    return { status: res.status, body };
  } catch (e) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    return { status: 0, body: String((e as Error)?.message ?? e) };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/** models.list with pagination. Returns the HTTP error result on failure. */
export async function listModels(
  key: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ models: ApiModel[] } | HttpResult> {
  const models: ApiModel[] = [];
  let pageToken = "";
  do {
    const url = `${GEMINI_BASE}/models?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`;
    const r = await httpJson(url, key, { method: "GET" }, 15000, undefined, fetchImpl);
    if (r.status !== 200) return r;
    const b = r.body as { models?: ApiModel[]; nextPageToken?: string };
    models.push(...(b.models ?? []));
    pageToken = b.nextPageToken ?? "";
  } while (pageToken);
  return { models };
}

export class Semaphore {
  private active = 0;
  private queue: (() => void)[] = [];
  constructor(private limit: () => number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit()) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

export interface CallSpec<T> {
  system: string;
  /**
   * The candidate's own data (trusted, the same across a fill's calls), sent ahead of `payload` so providers reuse
   * it from their prompt cache: Gemini gets one JSON object with it first; Claude gets it in the system prompt.
   */
  context?: object;
  payload: unknown;
  /** Gemini responseSchema; omit for JSON mode without a schema (parseResume). */
  schema?: object;
  validate: (data: unknown) => T;
  essay?: boolean;
  /** The AI review or YOLO's navigator: the deepest thinking the model takes (reviewThinking). */
  review?: boolean;
  timeoutMs: number;
  signal?: AbortSignal;
  maxOutputTokens?: number;
}

export interface CallResult<T> {
  data: T;
  usedModel: string;
  keyLabel: string;
}

export interface GeminiDeps {
  pool: KeyPool;
  getCaps: (model: string) => ModelCaps | undefined;
  setCaps: (model: string, caps: ModelCaps) => void;
  concurrency: () => number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** When true, prompts/responses are logged to the SW console (never keys). */
  debug?: () => boolean;
}

type RunResult =
  | { kind: "ok"; body: unknown; key: ApiKeyEntry }
  | { kind: "capability"; what: "thinking" | "schema"; message: string; key: ApiKeyEntry }
  | { kind: "exhausted" }
  | { kind: "server"; message: string }
  | { kind: "modelGone" };

interface Ctx {
  timeoutMs: number;
  signal?: AbortSignal;
  attempts: { n: number; max: number };
}

/** The system prompt with the reply's schema written into it, for when the model isn't given the schema itself. */
export const promptWithSchema = (system: string, schema: object) =>
  `${system}\n\nJSON schema of the reply:\n${JSON.stringify(schema)}`;

export function buildBody(
  system: string,
  payload: unknown,
  schema: object | undefined,
  caps: Pick<ModelCaps, "schema">,
  thinking: ThinkingCap,
  maxOutputTokens = 8192,
) {
  const promptOnly = !!schema && caps.schema === "promptOnly";
  const tc = thinkingConfig(thinking);
  return {
    systemInstruction: {
      parts: [{ text: promptOnly ? promptWithSchema(system, schema) : system }],
    },
    contents: [{ role: "user", parts: [{ text: typeof payload === "string" ? payload : JSON.stringify(payload) }] }],
    generationConfig: {
      responseMimeType: "application/json",
      ...(schema && !promptOnly ? { responseSchema: schema } : {}),
      maxOutputTokens,
      // Fixed seed: same prompt → same answer (best-effort). Temperature stays default (PROMPT.md: no sampling params).
      seed: 1,
      ...(tc ? { thinkingConfig: tc } : {}),
    },
  };
}

/** Extracts and validates the JSON reply (§10.1 response handling). */
export function parseOutput<T>(body: unknown, validate: (d: unknown) => T): T {
  const cand = (
    body as { candidates?: { finishReason?: string; content?: { parts?: { text?: string; thought?: boolean }[] } }[] }
  )?.candidates?.[0];
  if (cand?.finishReason === "MAX_TOKENS") throw new BadOutputError("Response truncated (MAX_TOKENS)", true);
  const text = (cand?.content?.parts ?? [])
    .filter((p) => !p.thought && typeof p.text === "string")
    .map((p) => p.text)
    .join("");
  return parseJsonReply(text, validate);
}

/** Parses a JSON reply (a ```json fence allowed) and validates it. */
export function parseJsonReply<T>(text: string, validate: (d: unknown) => T): T {
  let data: unknown;
  try {
    data = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    throw new BadOutputError("Invalid JSON from model");
  }
  try {
    return validate(data);
  } catch (e) {
    throw new BadOutputError(`Response did not match schema: ${(e as Error).message.slice(0, 200)}`);
  }
}

export function createGemini(deps: GeminiDeps) {
  const { pool } = deps;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const sem = new Semaphore(deps.concurrency);
  const log = (...a: unknown[]) => {
    if (deps.debug?.()) console.log(...a);
  };

  async function runOnModel(model: string, body: unknown, ctx: Ctx, preferKey?: string): Promise<RunResult> {
    let serverRetries = 0;
    for (;;) {
      if (ctx.attempts.n > ctx.attempts.max) return { kind: "exhausted" };
      const key = pool.select(model, preferKey);
      preferKey = undefined;
      if (!key) return { kind: "exhausted" };
      ctx.attempts.n++;
      const url = `${GEMINI_BASE}/models/${encodeURIComponent(model)}:generateContent`;
      const res = await httpJson(url, key.key, { method: "POST", body }, ctx.timeoutMs, ctx.signal, deps.fetchImpl);
      const c = classify(res.status, res.body);
      pool.record(key.id, model, c, res.status);
      log(`[gemini] ${model} key=${key.label} → ${res.status} ${c.kind}`);
      switch (c.kind) {
        case "success":
          return { kind: "ok", body: res.body, key };
        case "rotateKey":
          continue;
        case "serverTransient":
          if (++serverRetries <= 2) {
            await sleep(250 + Math.random() * 500);
            continue;
          }
          return { kind: "server", message: c.message };
        case "capability":
          return { kind: "capability", what: c.what, message: c.message, key };
        case "modelGone":
          pool.markModelGone(model);
          return { kind: "modelGone" };
        case "blocked":
          throw new BlockedError(c.message);
        case "badRequest":
          throw new BadRequestError(c.message);
      }
    }
  }

  const failure = (model: string, r: RunResult): Error =>
    r.kind === "server"
      ? new ServerError(`Gemini is unavailable right now (${r.message}).`)
      : r.kind === "modelGone"
        ? new ModelGoneError(model)
        : new AllKeysExhaustedError(model, pool.earliestRetryAt(model), pool.reasons(model));

  /** Probe chain (§10.4): first thinking config that returns 200, with schema fallback. */
  async function probe(model: string, ctx: Ctx): Promise<ModelCaps> {
    let schema: ModelCaps["schema"] = "responseSchema";
    for (const thinking of THINKING_CHAIN) {
      for (;;) {
        const body = buildBody(VALIDATION_PROMPT, '{"ping":true}', VALIDATION_SCHEMA, { schema }, thinking, 256);
        const r = await runOnModel(model, body, ctx);
        if (r.kind === "ok") {
          const caps: ModelCaps = { thinking, schema, verifiedAt: Date.now() };
          deps.setCaps(model, caps);
          return caps;
        }
        if (r.kind === "capability" && r.what === "schema" && schema === "responseSchema") {
          schema = "promptOnly";
          continue;
        }
        if (r.kind === "capability" && r.what === "thinking") break;
        if (r.kind === "capability") throw new BadRequestError(r.message);
        throw failure(model, r);
      }
    }
    throw new BadRequestError(`${model} rejected every thinking configuration.`);
  }

  async function ensureCaps(model: string, ctx: Ctx): Promise<ModelCaps> {
    const c = deps.getCaps(model);
    return isFresh(c) ? c : probe(model, ctx);
  }

  const newCtx = (timeoutMs: number, signal?: AbortSignal): Ctx => ({
    timeoutMs,
    signal,
    attempts: { n: 0, max: 2 * pool.keys.length + 4 },
  });

  /** generateContent with rotation, capability adjustment, output validation and model fallback. */
  async function call<T>(spec: CallSpec<T>, opts: { model: string; fallback?: string | null }): Promise<CallResult<T>> {
    if (!pool.keys.length) throw new NoKeysError();
    return sem.run(async () => {
      const ctx = newCtx(spec.timeoutMs, spec.signal);
      const models = [opts.model, opts.fallback].filter((m, i, a): m is string => !!m && a.indexOf(m) === i);
      const payload = spec.context ? { ...spec.context, ...(spec.payload as object) } : spec.payload;
      const errors: Error[] = [];
      for (const model of models) {
        let caps: ModelCaps;
        try {
          caps = await ensureCaps(model, ctx);
        } catch (e) {
          if (e instanceof AllKeysExhaustedError || e instanceof ServerError || e instanceof ModelGoneError) {
            errors.push(e);
            continue;
          }
          throw e;
        }
        let capRetried = false;
        let badOutputRetried = false;
        let preferKey: string | undefined;
        for (;;) {
          const thinking = spec.essay ? essayThinking(caps) : spec.review ? reviewThinking(caps) : caps.thinking;
          const body = buildBody(spec.system, payload, spec.schema, caps, thinking, spec.maxOutputTokens);
          if (deps.debug?.()) log("[gemini] request", model, JSON.stringify(body).slice(0, 4000));
          const r = await runOnModel(model, body, ctx, preferKey);
          preferKey = undefined;
          if (r.kind === "ok") {
            if (spec.essay && thinking !== caps.thinking && !caps.essayThinking) {
              caps = { ...caps, essayThinking: thinking };
              deps.setCaps(model, caps);
            }
            if (spec.review && thinking !== caps.thinking && !caps.reviewThinking) {
              caps = { ...caps, reviewThinking: thinking };
              deps.setCaps(model, caps);
            }
            try {
              const data = parseOutput(r.body, spec.validate);
              if (deps.debug?.()) {
                log("[gemini] response", model, JSON.stringify(data).slice(0, 4000));
                log("[gemini] usage", model, JSON.stringify((r.body as { usageMetadata?: unknown }).usageMetadata));
              }
              return { data, usedModel: model, keyLabel: r.key.label };
            } catch (e) {
              if (!(e instanceof BadOutputError) || e.truncated) throw e;
              if (!badOutputRetried) {
                badOutputRetried = true;
                continue;
              }
              errors.push(e);
              break;
            }
          }
          if (r.kind === "capability") {
            if (capRetried) {
              errors.push(new BadRequestError(r.message));
              break;
            }
            capRetried = true;
            preferKey = r.key.id;
            if (r.what === "schema") caps = { ...caps, schema: "promptOnly" };
            else if (spec.essay && thinking !== caps.thinking) caps = { ...caps, essayThinking: caps.thinking };
            else if (spec.review && thinking !== caps.thinking) caps = { ...caps, reviewThinking: caps.thinking };
            else caps = { ...caps, thinking: nextThinking(caps.thinking) ?? { kind: "none" } };
            deps.setCaps(model, caps);
            continue;
          }
          errors.push(failure(model, r));
          break;
        }
      }
      const exhausted = errors.filter((e): e is AllKeysExhaustedError => e instanceof AllKeysExhaustedError);
      if (exhausted.length && exhausted.length === errors.length) {
        const times = exhausted.map((e) => e.earliestRetryAt).filter((t): t is number => t !== undefined);
        throw new AllKeysExhaustedError(
          opts.model,
          times.length ? Math.min(...times) : undefined,
          Object.assign({}, ...exhausted.map((e) => e.reasonsPerKey)),
        );
      }
      throw errors.find((e) => !(e instanceof AllKeysExhaustedError)) ?? errors[0] ?? new NoKeysError();
    });
  }

  /** Re-probe a model now (validation call on selection). */
  async function validateModel(model: string): Promise<ModelCaps> {
    if (!pool.keys.length) throw new NoKeysError();
    return probe(model, newCtx(15000));
  }

  return { call, validateModel, ensureCaps: (m: string) => ensureCaps(m, newCtx(15000)) };
}

export type Gemini = ReturnType<typeof createGemini>;

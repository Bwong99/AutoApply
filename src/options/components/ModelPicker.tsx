import { useEffect, useState } from "preact/hooks";
import { modelBadges, visibleModels } from "../../background/gemini/models";
import { isErr, send } from "../../shared/messages";
import { formatDateTime } from "../../shared/time";
import { save, useStored } from "../store";

type Check = { state: "busy" | "ok" | "err"; text: string } | null;

function List(props: {
  label: string;
  value: string | null;
  disabled?: string | null;
  allowNone?: boolean;
  onPick: (id: string | null) => void;
}) {
  const catalog = useStored("modelCatalog") ?? {};
  const fetchedAt = useStored("modelListFetchedAt") ?? 0;
  const [q, setQ] = useState("");
  const models = visibleModels(catalog, fetchedAt).filter(
    ([id, e]) => !q || `${id} ${e.displayName}`.toLowerCase().includes(q.toLowerCase()),
  );
  const name = `m-${props.label}`;
  return (
    <fieldset class="model-list">
      <legend>{props.label}</legend>
      <input
        type="search"
        placeholder="Search models"
        aria-label={`Search ${props.label}`}
        value={q}
        onInput={(e) => setQ(e.currentTarget.value)}
      />
      <div class="models" role="radiogroup" aria-label={props.label}>
        {props.allowNone && (
          <label class="model">
            <input type="radio" name={name} checked={!props.value} onChange={() => props.onPick(null)} /> None
          </label>
        )}
        {models.map(([id, e]) => (
          <label class={`model ${id === props.disabled ? "disabled" : ""}`}>
            <input
              type="radio"
              name={name}
              value={id}
              checked={props.value === id}
              disabled={id === props.disabled}
              onChange={() => props.onPick(id)}
            />
            <span>
              {e.displayName} <span class="muted mono">{id}</span>{" "}
              {modelBadges(id, e, catalog).map((b) => (
                <span class={`badge ${b.toLowerCase()}`}>{b}</span>
              ))}
            </span>
          </label>
        ))}
        {!models.length && <p class="muted">No models yet — add a key, then refresh.</p>}
      </div>
    </fieldset>
  );
}

export function ModelPicker(props: { showFallback?: boolean }) {
  const selected = useStored("selectedModel");
  const fallback = useStored("fallbackModel") ?? null;
  const review = useStored("reviewModel") ?? null;
  const fetchedAt = useStored("modelListFetchedAt") ?? 0;
  const [check, setCheck] = useState<Check>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshErr, setRefreshErr] = useState("");

  const refresh = async (force: boolean) => {
    setRefreshing(true);
    const r = await send({ type: "REFRESH_MODELS", force });
    setRefreshErr(isErr(r) ? r.error.message : "");
    setRefreshing(false);
  };
  useEffect(() => void refresh(false), []);

  const validate = async (id: string) => {
    setCheck({ state: "busy", text: `Validating ${id}…` });
    const r = await send({ type: "VALIDATE_MODEL", model: id });
    setCheck(isErr(r) ? { state: "err", text: `✗ ${r.error.message}` } : { state: "ok", text: `✓ ${id} works` });
  };

  return (
    <section class="panel-box">
      <h2>Model</h2>
      <p>Only text models that support generateContent are listed, newest-added first.</p>
      <div class="row">
        <button type="button" class="btn" onClick={() => void refresh(true)} disabled={refreshing}>
          {refreshing ? "Refreshing…" : "Refresh list"}
        </button>
        <span class="muted">Last updated {fetchedAt ? formatDateTime(fetchedAt) : "never"}</span>
      </div>
      {refreshErr && <p class="err">{refreshErr}</p>}
      <List
        label="Primary model (required)"
        value={selected ?? null}
        onPick={(id) => {
          if (!id) return;
          void save({ selectedModel: id, ...(fallback === id ? { fallbackModel: null } : {}) });
          void validate(id);
        }}
      />
      {check && (
        <p class={check.state === "err" ? "err" : check.state === "ok" ? "ok" : "muted"} role="status">
          {check.text}
        </p>
      )}
      {props.showFallback && (
        <List
          label="Fallback model (optional)"
          value={fallback}
          disabled={selected}
          allowNone
          onPick={(id) => {
            void save({ fallbackModel: id });
            if (id) void validate(id);
          }}
        />
      )}
      {props.showFallback && (
        <List
          label="Review model (optional; none = the primary model)"
          value={review}
          allowNone
          onPick={(id) => {
            void save({ reviewModel: id });
            if (id) void validate(id);
          }}
        />
      )}
      {props.showFallback && (
        <p class="muted">
          The AI review of each filled page and YOLO's navigator use this model, thinking as hard as it allows. A
          stronger (Pro) model catches more mistakes.
        </p>
      )}
    </section>
  );
}

import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";

let uid = 0;
const useId = () => useState(() => `c${++uid}`)[0];

export function Field(props: {
  label: string;
  help?: string;
  extra?: ComponentChildren;
  wide?: boolean | "full";
  children: (id: string) => ComponentChildren;
}) {
  const id = useId();
  return (
    <div class={props.wide === "full" ? "field full" : props.wide ? "field wide" : "field"}>
      <label for={id}>{props.label}</label>
      {props.children(id)}
      {props.extra}
      {props.help && <p class="help">{props.help}</p>}
    </div>
  );
}

export function TextInput(props: {
  label: string;
  help?: string;
  value: string;
  onInput: (v: string) => void;
  type?: string;
  multiline?: boolean;
  placeholder?: string;
  extra?: ComponentChildren;
  wide?: boolean | "full";
}) {
  return (
    <Field label={props.label} help={props.help} extra={props.extra} wide={props.wide}>
      {(id) =>
        props.multiline ? (
          <textarea
            id={id}
            rows={5}
            value={props.value}
            placeholder={props.placeholder}
            onInput={(e) => props.onInput(e.currentTarget.value)}
          />
        ) : (
          <input
            id={id}
            type={props.type ?? "text"}
            value={props.value}
            placeholder={props.placeholder}
            onInput={(e) => props.onInput(e.currentTarget.value)}
          />
        )
      }
    </Field>
  );
}

/** Yes / No / Unset segmented control, plus Decline where allowed. */
export function TriState(props: {
  label: string;
  help?: string;
  value: string;
  decline?: boolean;
  onChange: (v: string) => void;
}) {
  const opts: [string, string][] = [
    ["yes", "Yes"],
    ["no", "No"],
    ...(props.decline ? ([["decline", "Decline"]] as [string, string][]) : []),
    ["", "Unset"],
  ];
  return (
    <div class="field">
      <span class="label">{props.label}</span>
      <div class="seg" role="radiogroup" aria-label={props.label}>
        {opts.map(([v, t]) => (
          <button
            type="button"
            role="radio"
            aria-checked={props.value === v}
            class={props.value === v ? "on" : ""}
            onClick={() => props.onChange(v)}
          >
            {t}
          </button>
        ))}
      </div>
      {props.help && <p class="help">{props.help}</p>}
    </div>
  );
}

export function TagInput(props: {
  label: string;
  help?: string;
  value: string[];
  onChange: (v: string[]) => void;
  extra?: ComponentChildren;
}) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const parts = draft
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s && !props.value.includes(s));
    if (parts.length) props.onChange([...props.value, ...parts]);
    setDraft("");
  };
  return (
    <Field label={props.label} help={props.help} extra={props.extra}>
      {(id) => (
        <div class="tags">
          {props.value.map((t) => (
            <span class="tag">
              {t}
              <button
                type="button"
                aria-label={`Remove ${t}`}
                onClick={() => props.onChange(props.value.filter((x) => x !== t))}
              >
                ×
              </button>
            </span>
          ))}
          <input
            id={id}
            value={draft}
            placeholder="Type and press Enter"
            onInput={(e) => setDraft(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === ",") {
                e.preventDefault();
                add();
              } else if (e.key === "Backspace" && !draft && props.value.length)
                props.onChange(props.value.slice(0, -1));
            }}
            onBlur={add}
          />
        </div>
      )}
    </Field>
  );
}

export function Toggle(props: {
  label: string;
  help?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  const id = useId();
  return (
    <div class="field toggle">
      <input
        id={id}
        type="checkbox"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.currentTarget.checked)}
      />
      <label for={id}>{props.label}</label>
      {props.help && <p class="help">{props.help}</p>}
    </div>
  );
}

export function NumberInput(props: {
  label: string;
  help?: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  return (
    <Field label={props.label} help={props.help}>
      {(id) => (
        <input
          id={id}
          type="number"
          min={props.min}
          max={props.max}
          value={props.value}
          onChange={(e) => {
            const n = Math.round(Number(e.currentTarget.value));
            if (Number.isFinite(n)) props.onChange(Math.min(props.max, Math.max(props.min, n)));
          }}
        />
      )}
    </Field>
  );
}

export function SelectInput(props: {
  label: string;
  help?: string;
  value: string;
  options: [string, string][];
  onChange: (v: string) => void;
}) {
  return (
    <Field label={props.label} help={props.help}>
      {(id) => (
        <select id={id} value={props.value} onChange={(e) => props.onChange(e.currentTarget.value)}>
          {props.options.map(([v, t]) => (
            <option value={v}>{t}</option>
          ))}
        </select>
      )}
    </Field>
  );
}

/** Repeatable cards with add / remove / reorder. */
export function Cards<T>(props: {
  title: string;
  items: T[];
  make: () => T;
  onChange: (items: T[]) => void;
  render: (item: T, update: (fn: (t: T) => void) => void) => ComponentChildren;
}) {
  const { items, onChange } = props;
  const move = (i: number, d: number) => {
    const next = [...items];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    onChange(next);
  };
  return (
    <section class="cards">
      {items.map((it, i) => (
        <div class="card">
          <div class="card-head">
            <b>
              {props.title} {i + 1}
            </b>
            <span>
              <button
                type="button"
                class="btn small"
                disabled={i === 0}
                onClick={() => move(i, -1)}
                aria-label="Move up"
              >
                ↑
              </button>
              <button
                type="button"
                class="btn small"
                disabled={i === items.length - 1}
                onClick={() => move(i, 1)}
                aria-label="Move down"
              >
                ↓
              </button>
              <button type="button" class="btn small danger" onClick={() => onChange(items.filter((_, j) => j !== i))}>
                Remove
              </button>
            </span>
          </div>
          {props.render(it, (fn) => {
            const next = structuredClone(items);
            fn(next[i]);
            onChange(next);
          })}
        </div>
      ))}
      <button type="button" class="btn" onClick={() => onChange([...items, props.make()])}>
        + Add {props.title.toLowerCase()}
      </button>
    </section>
  );
}

export function Meter(props: { value: number; label: string }) {
  return (
    <div class="meter">
      <div class="meter-label">
        {props.label}: <b>{props.value}%</b>
      </div>
      <div class="meter-bar" role="progressbar" aria-valuenow={props.value} aria-valuemin={0} aria-valuemax={100}>
        <span style={{ width: `${props.value}%` }} />
      </div>
    </div>
  );
}

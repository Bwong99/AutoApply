import { ONE_PAGE_WORDS } from "../../shared/constants";
import type { Settings } from "../../shared/types";
import {
  Cards,
  Field,
  Meter,
  NumberInput,
  SelectInput,
  TagInput,
  TextInput,
  Toggle,
  TriState,
} from "../components/controls";
import { PROFILE_GROUPS, type CardSpec, type FieldSpec } from "../profileFields";
import { completeness, getPath, save, setPath, useProfile, useStored } from "../store";

/** Renders one field spec against `obj`; `change` receives the dotted path and the new value. */
function renderField(f: FieldSpec, obj: object, change: (path: string, v: unknown) => void) {
  const v = getPath(obj, f.path);
  const set = (x: unknown) => change(f.path, x);
  switch (f.k) {
    case "yn":
    case "ynd":
      return (
        <TriState label={f.label} help={f.help} value={(v as string) ?? ""} decline={f.k === "ynd"} onChange={set} />
      );
    case "tags":
      return <TagInput label={f.label} help={f.help} value={(v as string[]) ?? []} onChange={set} />;
    case "bool":
      return <Toggle label={f.label} help={f.help} checked={!!v} onChange={set} />;
    case "select":
      return (
        <SelectInput label={f.label} help={f.help} value={(v as string) ?? ""} options={f.options} onChange={set} />
      );
    case "multi": {
      const list = (v as string[]) ?? [];
      return (
        <fieldset class="field">
          <legend class="label">{f.label}</legend>
          {f.options.map(([val, text]) => (
            <label class="inline">
              <input
                type="checkbox"
                checked={list.includes(val)}
                onChange={(e) => set(e.currentTarget.checked ? [...list, val] : list.filter((x) => x !== val))}
              />{" "}
              {text}
            </label>
          ))}
          <p class="help">{f.help}</p>
        </fieldset>
      );
    }
    case "decl":
    case "tagsdecl": {
      const declined = f.k === "decl" ? v === "decline" : Array.isArray(v) && v[0] === "decline";
      const toggle = (
        <Toggle
          label="Decline to answer"
          checked={declined}
          onChange={(on) => set(on ? (f.k === "decl" ? "decline" : ["decline"]) : f.k === "decl" ? "" : [])}
        />
      );
      return declined ? (
        <Field label={f.label} help={f.help} extra={toggle}>
          {(id) => <input id={id} value="Declined" disabled />}
        </Field>
      ) : f.k === "decl" ? (
        <TextInput label={f.label} help={f.help} value={(v as string) ?? ""} onInput={set} extra={toggle} />
      ) : (
        <TagInput label={f.label} help={f.help} value={(v as string[]) ?? []} onChange={set} extra={toggle} />
      );
    }
    default:
      return (
        <TextInput
          label={f.label}
          help={f.help}
          value={(v as string) ?? ""}
          type={f.k === "textarea" ? undefined : f.k}
          multiline={f.k === "textarea"}
          onInput={set}
          extra={f.extra && renderField(f.extra, obj, change)}
          wide={f.wide}
        />
      );
  }
}

export function Profile({ group }: { group: string }) {
  const [profile, update] = useProfile();
  const spec = PROFILE_GROUPS.find((g) => g.id === group) ?? PROFILE_GROUPS[0];
  if (!profile) return <p>Loading…</p>;
  const change = (path: string, v: unknown) => update((p) => setPath(p, path, v));
  return (
    <section>
      <h1>{spec.title}</h1>
      <Meter label="Profile completeness" value={completeness(profile)} />
      <p class="intro">{spec.intro}</p>
      <p class="intro">
        Filled-in fields are sent to the AI you chose (Gemini with your key, or Claude with your plan) when a form needs
        AI.
      </p>
      <nav class="subnav" aria-label="Profile sections">
        {PROFILE_GROUPS.map((g) => (
          <a href={`#/profile/${g.id}`} aria-current={g.id === spec.id ? "page" : undefined}>
            {g.title}
          </a>
        ))}
      </nav>
      <div class="form">
        {spec.items.map((item) =>
          "card" in item ? (
            <CardList card={item} profile={profile} change={change} />
          ) : (
            renderField(item, profile, change)
          ),
        )}
        {spec.id === "essayGuidance" && <EssaySettings />}
      </div>
    </section>
  );
}

function EssaySettings() {
  const s = useStored("settings");
  if (!s) return <p>Loading…</p>;
  const set = (patch: Partial<Settings>) => void save({ settings: { ...s, ...patch } });
  return (
    <>
      <NumberInput
        label="Essay length (words)"
        help="Target length when a question gives no limit."
        value={s.essayDefaultWords}
        min={10}
        max={2000}
        onChange={(essayDefaultWords) => set({ essayDefaultWords })}
      />
      <NumberInput
        label="Cover letter length (words)"
        help="Target length for cover-letter text boxes."
        value={s.coverLetterDefaultWords}
        min={10}
        max={2000}
        onChange={(coverLetterDefaultWords) => set({ coverLetterDefaultWords })}
      />
      <Toggle
        label="Keep generated cover letters to one page"
        help={`Cover letter PDFs written for autofill and YOLO. Their length target is at most ${ONE_PAGE_WORDS} words, and a letter that still runs past one page is written again shorter, once; if it still doesn't fit, the upload is left for you. Off: any length.`}
        checked={s.coverLetterOnePage}
        onChange={(coverLetterOnePage) => set({ coverLetterOnePage })}
      />
    </>
  );
}

function CardList(props: { card: CardSpec; profile: object; change: (path: string, v: unknown) => void }) {
  const { card } = props;
  return (
    <Cards<object>
      title={card.title}
      items={(getPath(props.profile, card.path) as object[]) ?? []}
      make={card.make}
      onChange={(items) => props.change(card.path, items)}
      render={(item, updateItem) => {
        const set = (path: string, v: unknown) => updateItem((it) => setPath(it, path, v));
        return (
          <div class="form">
            {card.fields.map((f) =>
              Array.isArray(f) ? <div>{f.map((g) => renderField(g, item, set))}</div> : renderField(f, item, set),
            )}
          </div>
        );
      }}
    />
  );
}

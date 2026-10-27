import { useState } from "react";
import { formatMoney } from "@shared/format";
import { typeInFromKeep } from "@shared/book";
import type { SeatPriceView } from "@shared/pricing";
import { cn } from "@/lib/utils";

function keepToInput(value: number | null): string {
  if (value == null) return "";
  return value.toFixed(2);
}

function typeToInput(value: number | null): string {
  if (value == null) return "";
  return String(value);
}

function parseKeep(text: string): number | null {
  const cleaned = text.replace(/[$,\s]/g, "");
  if (cleaned === "") return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}

function parseTypeIn(text: string): number | null {
  const cleaned = text.replace(/[$,\s]/g, "");
  if (cleaned === "") return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.max(1, Math.round(value));
}

function emptyReason(note: string | null): string {
  if (note && /cheap/i.test(note)) {
    return "One cheap 107P listing is the only seat up, so there is no price yet.";
  }
  return "Similar lower-bowl seats are not listed yet.";
}

function DollarField({
  label,
  hint,
  textValue,
  opponent,
  aria,
  currentTypeIn,
  parse,
  onCommit,
  onClear,
  compact = false,
}: {
  label: string;
  hint: string;
  textValue: string;
  opponent: string;
  aria?: string;
  currentTypeIn: number | null;
  parse: (text: string) => { typeIn: number } | null;
  onCommit: (typeIn: number) => void;
  onClear: () => void;
  compact?: boolean;
}) {
  const [text, setText] = useState(textValue);
  const [focused, setFocused] = useState(false);
  const [synced, setSynced] = useState(textValue);
  if (!focused && synced !== textValue) {
    setSynced(textValue);
    setText(textValue);
  }
  const empty = text.trim() === "";

  return (
    <label className="block min-w-0">
      <span className="block text-[11px] font-semibold text-foreground/75">{label}</span>
      {compact ? null : <span className="block text-[11px] leading-tight text-muted-foreground">{hint}</span>}
      <span
        className={cn(
          "mt-1 flex items-center rounded-lg border bg-white px-2",
          compact ? "h-9 px-1.5" : "min-h-12",
          empty ? "border-dashed border-line" : "border-[#c4bbaa]",
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            "pr-0.5 font-bold tabular-nums",
            compact ? "text-sm" : "text-lg",
            empty ? "text-muted-foreground" : "text-navy",
          )}
        >
          $
        </span>
        <input
          className={cn(
            "w-full min-w-0 bg-transparent font-bold tabular-nums text-navy outline-none placeholder:font-semibold placeholder:text-[#9aa1ad]",
            compact ? "text-sm placeholder:text-sm" : "text-xl placeholder:text-base",
          )}
          inputMode="decimal"
          autoComplete="off"
          placeholder="—"
          aria-label={aria ?? `${label}, ${hint}, for ${opponent}`}
          value={text}
          onFocus={() => setFocused(true)}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") (event.target as HTMLInputElement).blur();
          }}
          onBlur={() => {
            setFocused(false);
            if (text.trim() === "") {
              onClear();
              setText("");
              return;
            }
            const parsed = parse(text);
            if (!parsed) {
              setText(textValue);
              return;
            }
            if (parsed.typeIn === currentTypeIn) {
              setText(textValue);
              return;
            }
            onCommit(parsed.typeIn);
          }}
        />
      </span>
    </label>
  );
}

function suggestionLines(view: SeatPriceView): string[] {
  const suggestion = view.suggestion;
  if (!suggestion) return [];
  const comps = suggestion.heldPrior
    ? `None listed today; recently around ${formatMoney(suggestion.listedMedian)}`
    : `Similar seats ~${formatMoney(suggestion.listedMedian)}${
        suggestion.compCount != null && suggestion.compCount > 0 ? ` · ${suggestion.compCount} listed` : ""
      }`;
  return [
    `${comps}${suggestion.excludedDump ? " · one cheap 107P left out" : ""}`,
    suggestion.label,
    suggestion.historyNote ?? "",
  ].filter(Boolean);
}

/**
 * Per-seat price editor. Two linked fields (what you keep, what you type in).
 * `compact` is the table-row version: short labels, the model notes move to a tooltip.
 */
export function SeatPrice({
  opponent,
  view,
  compact = false,
  onTypeIn,
  onClear,
}: {
  opponent: string;
  view: SeatPriceView;
  compact?: boolean;
  onTypeIn: (typeIn: number) => void;
  onClear: () => void;
}) {
  const suggestion = view.suggestion;
  const open = view.typeIn == null;
  const notes = suggestionLines(view);
  const fields = (
    <div className={cn("grid gap-2", compact ? "grid-cols-2" : "grid-cols-1 gap-3 min-[420px]:grid-cols-2")}>
      <DollarField
        compact={compact}
        label={compact ? "You keep" : "You keep / seat"}
        hint="per seat"
        aria={`You keep per seat for ${opponent}`}
        textValue={keepToInput(view.keep)}
        opponent={opponent}
        currentTypeIn={view.typeIn}
        parse={(text) => {
          const keep = parseKeep(text);
          if (keep == null) return null;
          return { typeIn: typeInFromKeep(keep) };
        }}
        onCommit={onTypeIn}
        onClear={onClear}
      />
      <DollarField
        compact={compact}
        label={compact ? "Type in" : "Your price / seat"}
        hint="Account Manager"
        aria={`Number to type into Wizards Account Manager for ${opponent}, per seat`}
        textValue={typeToInput(view.typeIn)}
        opponent={opponent}
        currentTypeIn={view.typeIn}
        parse={(text) => {
          const typeIn = parseTypeIn(text);
          if (typeIn == null) return null;
          return { typeIn };
        }}
        onCommit={onTypeIn}
        onClear={onClear}
      />
    </div>
  );

  const reset = view.hasSaved ? (
    <button
      type="button"
      className="font-semibold text-navy underline underline-offset-2"
      onClick={onClear}
    >
      {suggestion ? "Use suggested" : "Clear saved price"}
    </button>
  ) : null;

  if (compact) {
    return (
      <div className="min-w-0" title={open ? emptyReason(view.emptyNote) : notes.join("\n") || undefined}>
        {fields}
        <p className="mt-1 flex flex-wrap gap-x-2 text-xs leading-snug text-muted-foreground">
          {open ? <span>No price yet</span> : null}
          {suggestion ? <span>Model ${suggestion.typeIn}</span> : null}
          {reset}
        </p>
      </div>
    );
  }

  return (
    <div className="min-w-0">
      {open ? (
        <div className="rounded-xl border border-dashed border-[#c9c1b2] bg-[#faf8f4] px-3 py-3">
          <p className="text-base font-semibold text-navy">No price yet</p>
          <p className="mt-0.5 text-sm leading-snug text-muted-foreground">{emptyReason(view.emptyNote)}</p>
          <div className="mt-3">{fields}</div>
        </div>
      ) : (
        fields
      )}
      {notes.length ? (
        <div className="mt-2 space-y-1 text-xs leading-snug text-muted-foreground">
          {notes.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      ) : null}
      {view.hasSaved ? (
        <p className="mt-1.5 text-xs leading-snug text-muted-foreground">
          {view.usingOwn && suggestion ? <>Suggested: type ${suggestion.typeIn}, keep {formatMoney(suggestion.keep)}. </> : <>Saved on this game. </>}
          {reset}
        </p>
      ) : null}
    </div>
  );
}

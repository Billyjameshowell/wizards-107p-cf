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
      <span className="block text-[11px] font-semibold uppercase tracking-[0.07em] text-foreground/75">
        {label}
      </span>
      <span className="block text-[11px] leading-tight text-muted-foreground">{hint}</span>
      <span
        className={cn(
          "mt-1 flex min-h-12 items-center rounded-lg border bg-white px-2 lg:min-h-10",
          empty ? "border-dashed border-line" : "border-[#c4bbaa]",
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            "pr-0.5 text-lg font-bold tabular-nums",
            empty ? "text-muted-foreground" : "text-navy",
          )}
        >
          $
        </span>
        <input
          className="w-full min-w-0 bg-transparent text-xl font-bold tabular-nums text-navy outline-none placeholder:text-base placeholder:font-semibold placeholder:text-[#9aa1ad] lg:text-lg"
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

export function SeatPrice({
  opponent,
  view,
  showPair,
  onTypeIn,
  onClear,
}: {
  opponent: string;
  view: SeatPriceView;
  showPair: boolean;
  onTypeIn: (typeIn: number) => void;
  onClear: () => void;
}) {
  const suggestion = view.suggestion;
  const open = view.typeIn == null;
  const fields = (
    <div className={cn("grid gap-3", showPair ? "grid-cols-2" : "grid-cols-1 min-[420px]:grid-cols-2")}>
      <DollarField
        label="You keep"
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
        label="Type in"
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

  return (
    <div className={cn("min-w-0", showPair ? "" : "min-w-[15.5rem]")}>
      {open ? (
        <div
          className={cn(
            "rounded-xl border border-dashed border-[#c9c1b2] bg-[#faf8f4] px-3 py-3",
            !showPair && "px-2.5 py-2.5",
          )}
        >
          <p className="text-base font-semibold text-navy">No price yet</p>
          <p className="mt-0.5 text-sm leading-snug text-muted-foreground">{emptyReason(view.emptyNote)}</p>
          <div className="mt-3">{fields}</div>
        </div>
      ) : (
        fields
      )}
      {showPair ? (
        <p className="mt-3 flex items-baseline justify-between gap-3 border-t border-line pt-2.5">
          <span className="text-sm text-muted-foreground">You keep, both seats</span>
          <span
            className={cn(
              "text-xl font-bold tabular-nums",
              view.pair == null ? "text-muted-foreground" : "text-navy",
            )}
          >
            {formatMoney(view.pair)}
          </span>
        </p>
      ) : null}
      {suggestion ? (
        <div className="mt-2 space-y-1">
          <p className="text-[13px] leading-snug text-muted-foreground">
            {suggestion.heldPrior ? (
              <>
                No similar seats listed today. Recent ones were around{" "}
                {formatMoney(suggestion.listedMedian)}
              </>
            ) : (
              <>
                Listed around {formatMoney(suggestion.listedMedian)} for similar lower-bowl seats
                {suggestion.compCount != null && suggestion.compCount > 0
                  ? ` · ${suggestion.compCount} ${suggestion.compCount === 1 ? "listing" : "listings"}`
                  : ""}
              </>
            )}
            {suggestion.excludedDump ? " · left out one cheap 107P listing" : ""}
          </p>
          <p className="text-xs leading-snug text-muted-foreground">{suggestion.label}</p>
          {suggestion.historyNote ? (
            <p className="text-xs leading-snug text-muted-foreground">{suggestion.historyNote}</p>
          ) : null}
        </div>
      ) : null}
      {view.hasSaved ? (
        <p className="mt-1.5 text-xs leading-snug text-muted-foreground">
          {view.usingOwn && suggestion ? (
            <>
              Suggested you keep {formatMoney(suggestion.keep)} · type ${suggestion.typeIn}.{" "}
            </>
          ) : (
            <>Saved on this game. </>
          )}
          <button
            type="button"
            className="font-semibold text-navy underline underline-offset-2"
            onClick={onClear}
          >
            {suggestion ? "Use suggested" : "Clear saved price"}
          </button>
        </p>
      ) : null}
    </div>
  );
}

import { useState } from "react";
import { formatMoney } from "@shared/format";
import { typeInFromKeep } from "@shared/book";
import type { SeatPriceView } from "@shared/pricing";

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

function DollarField({
  label,
  textValue,
  opponent,
  currentTypeIn,
  parse,
  onCommit,
  onClear,
}: {
  label: string;
  textValue: string;
  opponent: string;
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

  return (
    <label className="block min-w-0">
      <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
        {label}
      </span>
      <input
        className="mt-0.5 w-full max-w-[8.5rem] min-h-11 rounded-md border border-line bg-white px-2 py-1.5 text-base font-semibold tabular-nums lg:min-h-9 lg:text-sm"
        inputMode="decimal"
        autoComplete="off"
        aria-label={`${label} for ${opponent}`}
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
  return (
    <div className="min-w-[11rem] space-y-1.5">
      <div className="flex flex-wrap gap-3">
        <DollarField
          label="You keep"
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
          label="Type in Set Your Price"
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
      {showPair ? (
        <p className="text-sm tabular-nums">
          <span className="text-muted-foreground">Both seats </span>
          <span className="font-semibold">{formatMoney(view.pair)}</span>
        </p>
      ) : null}
      {suggestion ? (
        <>
          <p className="text-xs leading-snug text-slate-700">
            Listed around {formatMoney(suggestion.listedMedian)}
            {suggestion.compCount != null && suggestion.compCount > 0
              ? ` · ${suggestion.compCount} ${suggestion.compCount === 1 ? "listing" : "listings"}`
              : ""}
            {suggestion.excludedDump ? " · left out one cheap Section 107 Row P listing" : ""}
          </p>
          <p className="text-xs leading-snug text-slate-700">{suggestion.label}</p>
        </>
      ) : (
        <p className="text-xs leading-snug text-slate-700">{view.emptyNote}</p>
      )}
      {view.hasSaved ? (
        <p className="text-xs leading-snug text-slate-700">
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

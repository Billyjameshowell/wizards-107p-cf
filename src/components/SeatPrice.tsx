import { useState } from "react";
import type { SeatPriceView } from "@shared/pricing";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@/components/ui/input-group";
import { money } from "@/lib/money";

function parseTypeIn(text: string): number | null {
  const cleaned = text.replace(/[$,\s]/g, "");
  if (cleaned === "") return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.max(1, Math.round(value));
}

function emptyReason(note: string | null): string {
  if (note && /cheap/i.test(note)) return "One cheap 107P listing is the only seat up, so there is no price yet.";
  return "Similar lower-bowl seats aren't listed yet, so there is no price yet.";
}

/**
 * The per-seat number to type into Account Manager. It saves on blur or Enter,
 * never while typing, and an empty field goes back to the suggestion.
 */
export function SeatPrice({
  opponent,
  view,
  onTypeIn,
  onClear,
}: {
  opponent: string;
  view: SeatPriceView;
  onTypeIn: (typeIn: number) => void;
  onClear: () => void;
}) {
  const source = view.typeIn == null ? "" : String(view.typeIn);
  const [text, setText] = useState(source);
  const [focused, setFocused] = useState(false);
  const [synced, setSynced] = useState(source);
  if (!focused && synced !== source) {
    setSynced(source);
    setText(source);
  }
  const suggestion = view.suggestion;

  function commit() {
    setFocused(false);
    if (text.trim() === "") {
      onClear();
      setText(source);
      return;
    }
    const typeIn = parseTypeIn(text);
    if (typeIn == null || typeIn === view.typeIn) {
      setText(source);
      return;
    }
    onTypeIn(typeIn);
  }

  return (
    <div className="space-y-2">
      <label className="block">
        <span className="text-sm text-muted-foreground">Your price per seat</span>
        <InputGroup className="mt-1 h-11 bg-card">
          <InputGroupAddon align="inline-start">
            <InputGroupText>$</InputGroupText>
          </InputGroupAddon>
          <InputGroupInput
            inputMode="numeric"
            autoComplete="off"
            enterKeyHint="done"
            placeholder={suggestion ? String(suggestion.typeIn) : "No price yet"}
            aria-label={`Price per seat to type into Account Manager for ${opponent}`}
            className="text-base font-medium tabular-nums"
            value={text}
            onFocus={() => setFocused(true)}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") (event.target as HTMLInputElement).blur();
            }}
            onBlur={commit}
          />
        </InputGroup>
      </label>
      <p className="text-sm text-muted-foreground">
        {view.typeIn == null
          ? emptyReason(view.emptyNote)
          : `You keep ${money(view.keep)} a seat and ${money(view.pair)} for the pair after the 5% fee.`}
      </p>
      {view.hasSaved ? (
        <Button type="button" variant="outline" size="sm" className="h-9" onClick={onClear}>
          {suggestion ? `Use the suggested $${suggestion.typeIn}` : "Clear my price"}
        </Button>
      ) : null}
    </div>
  );
}

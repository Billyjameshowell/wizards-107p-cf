import { useState } from "react";
import { Button } from "@ui-sdk/react/button";
import { Field, FieldDescription, FieldLabel } from "@ui-sdk/react/field";
import { Input, InputGroup } from "@ui-sdk/react/input";
import type { SeatPriceView } from "@shared/pricing";
import { textButtonClass } from "@/components/controls";
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
    <Field className="flex flex-col gap-1">
      <FieldLabel>
        Your price per seat
        <span className="sr-only"> for {opponent}</span>
      </FieldLabel>
      <InputGroup className="flex h-11 items-center gap-1 rounded-lg border border-input bg-card px-3">
        <span aria-hidden="true" className="text-muted-foreground">
          $
        </span>
        <Input
          inputMode="numeric"
          autoComplete="off"
          enterKeyHint="done"
          placeholder={suggestion ? String(suggestion.typeIn) : "No price yet"}
          value={text}
          onFocus={() => setFocused(true)}
          onValueChange={(value, details) => {
            if (value !== "" && !/^[\d$,.\s]*$/.test(value)) {
              details.cancel();
              return;
            }
            setText(value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
          onBlur={commit}
          className="h-11 min-w-0 flex-1 text-base font-medium tabular-nums outline-none"
        />
      </InputGroup>
      <FieldDescription>
        {view.typeIn == null
          ? emptyReason(view.emptyNote)
          : `You keep ${money(view.keep)} a seat and ${money(view.pair)} for the pair after the 5% fee.`}
      </FieldDescription>
      {view.hasSaved ? (
        <Button type="button" className={textButtonClass} onClick={onClear}>
          {suggestion ? `Use the suggested $${suggestion.typeIn}` : "Clear my price"}
        </Button>
      ) : null}
    </Field>
  );
}

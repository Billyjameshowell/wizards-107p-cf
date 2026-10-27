import type { ScenarioChoice } from "@/lib/scenario";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";

const CHOICES = ["Sit", "Sell"] as const;

/** Sit / Sell picker for one game. Fills its container; the caller sets the width. */
export function SitSellToggle({
  value,
  opponent,
  onChange,
  className,
}: {
  value: string;
  opponent: string;
  onChange: (choice: ScenarioChoice) => void;
  className?: string;
}) {
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      spacing={0}
      value={value === "Sit" || value === "Sell" ? value : ""}
      onValueChange={(next) => {
        if (next === "Sit" || next === "Sell") onChange(next);
      }}
      aria-label={`Sit or sell for ${opponent}`}
      className={cn("grid w-full grid-cols-2 bg-white", className)}
    >
      {CHOICES.map((choice) => (
        <ToggleGroupItem
          key={choice}
          value={choice}
          aria-label={`${choice} ${opponent}`}
          className={cn(
            "h-11 w-full border-[#c4bbaa] font-bold text-[#243044] lg:h-8",
            choice === "Sit"
              ? "data-[state=on]:bg-sit-ink data-[state=on]:text-white"
              : "data-[state=on]:bg-sell-ink data-[state=on]:text-white",
          )}
        >
          {choice}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

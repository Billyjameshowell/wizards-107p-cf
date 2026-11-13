import type { ScenarioChoice } from "@/lib/scenario";
import { SegmentedControl, SegmentedControlIndicator, SegmentedControlItem } from "@ui-sdk/react/segmented-control";
import { cn } from "@/lib/utils";

const CHOICES = ["Sit", "Sell"] as const;

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
  const selected = value === "Sit" || value === "Sell" ? value : null;
  return (
    <SegmentedControl
      aria-label={`Sit or sell for ${opponent}`}
      value={selected}
      onValueChange={(next, details) => {
        if (next !== "Sit" && next !== "Sell") {
          details.cancel();
          return;
        }
        onChange(next);
      }}
      className={cn("sit-sell grid-cols-2", className)}
    >
      <SegmentedControlIndicator />
      {CHOICES.map((choice) => (
        <SegmentedControlItem key={choice} value={choice} className={choice === "Sit" ? "is-sit" : "is-sell"}>
          {choice}
          <span className="sr-only"> {opponent}</span>
        </SegmentedControlItem>
      ))}
    </SegmentedControl>
  );
}

import type { ReactNode } from "react";
import { ArrowDownIcon, ArrowUpIcon, CheckIcon, ChevronDownIcon, SearchIcon, XIcon } from "lucide-react";
import {
  AlertDialog,
  AlertDialogBackdrop,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@ui-sdk/react/alert-dialog";
import { Button } from "@ui-sdk/react/button";
import { Field, FieldLabel } from "@ui-sdk/react/field";
import { Input, InputClear, InputGroup } from "@ui-sdk/react/input";
import { Select, SelectContent, SelectItem, SelectItemIndicator, SelectTrigger, SelectValue } from "@ui-sdk/react/select";
import { Toggle } from "@ui-sdk/react/toggle";
import { cn } from "@/lib/utils";

export const textButtonClass =
  "inline-flex h-9 items-center justify-center rounded-lg border border-border bg-card px-3 text-sm font-medium text-foreground hover:bg-muted disabled:pointer-events-none disabled:opacity-50";

const confirmClass =
  "inline-flex h-11 items-center justify-center rounded-lg border border-transparent bg-sell-ink px-3 text-sm font-medium text-white hover:bg-sell-ink/90";

export function GameSearch({ value, onValueChange }: { value: string; onValueChange: (value: string) => void }) {
  return (
    <InputGroup className="flex h-11 min-w-0 flex-1 items-center gap-2 rounded-lg border border-input bg-card px-3">
      <SearchIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      <Input
        type="search"
        value={value}
        onValueChange={onValueChange}
        placeholder="Search team or date"
        aria-label="Search games"
        autoComplete="off"
        className="h-11 min-w-0 flex-1 text-base outline-none [&::-webkit-search-cancel-button]:appearance-none"
      />
      <InputClear aria-label="Clear search" className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground">
        <XIcon aria-hidden="true" className="size-4" />
      </InputClear>
    </InputGroup>
  );
}

export function OptionSelect<T extends string>({
  label,
  value,
  onValueChange,
  options,
  className,
}: {
  label: string;
  value: T;
  onValueChange: (value: T) => void;
  options: { value: T; label: string }[];
  className?: string;
}) {
  return (
    <Field className={cn("flex min-w-0 flex-col", className)}>
      <FieldLabel className="sr-only">{label}</FieldLabel>
      <Select
        items={options}
        value={value}
        onValueChange={(next, details) => {
          if (typeof next !== "string" || !options.some((option) => option.value === next)) {
            details.cancel();
            return;
          }
          onValueChange(next as T);
        }}
      >
        <SelectTrigger>
          <SelectValue />
          <ChevronDownIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
              <SelectItemIndicator>
                <CheckIcon aria-hidden="true" className="size-4" />
              </SelectItemIndicator>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

export function SortDirection({
  direction,
  onChange,
}: {
  direction: "asc" | "desc";
  onChange: (direction: "asc" | "desc") => void;
}) {
  const descending = direction === "desc";
  return (
    <Toggle
      aria-label="Sort direction"
      pressed={descending}
      onPressedChange={(pressed) => onChange(pressed ? "desc" : "asc")}
      className="inline-flex size-11 shrink-0 items-center justify-center rounded-lg border border-input bg-card text-foreground hover:bg-muted data-pressed:bg-navy data-pressed:text-white"
    >
      {descending ? <ArrowDownIcon aria-hidden="true" className="size-4" /> : <ArrowUpIcon aria-hidden="true" className="size-4" />}
    </Toggle>
  );
}

export function ConfirmButton({
  label,
  title,
  description,
  confirm,
  onConfirm,
  disabled = false,
  className,
}: {
  label: string;
  title: string;
  description: string;
  confirm: string;
  onConfirm: () => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger disabled={disabled} className={cn(textButtonClass, className)}>
        {label}
      </AlertDialogTrigger>
      <AlertDialogBackdrop />
      <AlertDialogContent>
        <AlertDialogTitle>{title}</AlertDialogTitle>
        <AlertDialogDescription>{description}</AlertDialogDescription>
        <div className="mt-2 flex justify-end gap-2">
          <AlertDialogClose className={cn(textButtonClass, "h-11 px-4")}>Cancel</AlertDialogClose>
          <AlertDialogClose
            value="confirm"
            data-agent-confirm={description}
            action={() => {
              onConfirm();
            }}
            className={confirmClass}
          >
            {confirm}
          </AlertDialogClose>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function NamedLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return (
    <Button render={<a href={href} />} className={cn(textButtonClass, className)}>
      {children}
    </Button>
  );
}

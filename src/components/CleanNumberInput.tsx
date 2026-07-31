import { useEffect, useState, type InputHTMLAttributes } from "react";

type Props = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "type" | "value" | "onChange" | "onBlur" | "onFocus"
> & {
  value: number;
  /** Clamp + commit when the field loses focus or Enter is pressed. */
  onCommit: (value: number) => void;
  /** Used when the field is left empty. Defaults to `min` or 0. */
  emptyValue?: number;
  integer?: boolean;
};

/**
 * Number field that stays blank while you delete and type. Clamping only
 * happens on blur / Enter, so the form never fights mid-edit.
 */
export function CleanNumberInput({
  value,
  onCommit,
  emptyValue,
  integer = false,
  min,
  max,
  step,
  disabled,
  ...rest
}: Props) {
  const [draft, setDraft] = useState(format(value, integer));
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) setDraft(format(value, integer));
  }, [value, integer, focused]);

  const commit = (raw: string) => {
    const fallback =
      emptyValue ??
      (typeof min === "number" ? min : 0);
    const parsed = raw.trim() === "" ? fallback : Number(raw);
    let next = Number.isFinite(parsed) ? parsed : fallback;
    if (integer) next = Math.floor(next);
    if (typeof min === "number") next = Math.max(min, next);
    if (typeof max === "number") next = Math.min(max, next);
    onCommit(next);
    setDraft(format(next, integer));
  };

  return (
    <input
      {...rest}
      type="text"
      inputMode={integer ? "numeric" : "decimal"}
      autoComplete="off"
      spellCheck={false}
      disabled={disabled}
      value={draft}
      onFocus={(event) => {
        setFocused(true);
        event.currentTarget.select();
      }}
      onChange={(event) => {
        const next = event.target.value;
        if (next !== "" && !/^-?\d*\.?\d*$/.test(next)) return;
        setDraft(next);
      }}
      onBlur={() => {
        setFocused(false);
        commit(draft);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.currentTarget.blur();
        }
      }}
      min={min}
      max={max}
      step={step}
    />
  );
}

function format(value: number, integer: boolean): string {
  if (!Number.isFinite(value)) return "";
  return integer ? String(Math.floor(value)) : String(value);
}

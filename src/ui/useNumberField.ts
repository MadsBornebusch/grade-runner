import { useEffect, useRef, useState, type ChangeEvent } from "react";

/**
 * Buffers a numeric <input>'s text separately from the committed numeric
 * value. Without this, a fully-controlled `value={number}` input snaps back
 * to the last committed value (undoing the user's keystroke, including the
 * cursor position) the moment an edit passes through an invalid intermediate
 * state -- most commonly clearing the field to retype it, since "" parses to
 * NaN and gets rejected. We only push a change up once the typed text parses
 * to a real number, and only re-sync from the committed value when the field
 * isn't focused (so external changes, e.g. auto-fill, still show up).
 */
export function useNumberField(value: number, onChange: (next: number) => void) {
  const [text, setText] = useState(() => String(value));
  const editingRef = useRef(false);

  useEffect(() => {
    if (!editingRef.current) setText(String(value));
  }, [value]);

  return {
    value: text,
    onFocus: () => {
      editingRef.current = true;
    },
    onBlur: () => {
      editingRef.current = false;
      setText(String(value));
    },
    onChange: (e: ChangeEvent<HTMLInputElement>) => {
      setText(e.target.value);
      const next = e.target.valueAsNumber;
      if (!Number.isNaN(next)) onChange(next);
    },
  };
}

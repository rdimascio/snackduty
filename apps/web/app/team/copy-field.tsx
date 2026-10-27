import type { ReactNode } from "react";
import { useId, useState } from "react";

import { inputClassName, labelClassName, secondaryButtonClassName } from "./team-view";

export function absoluteUrl(path: string): string {
  const origin = globalThis.location?.origin;
  return origin === undefined ? path : new URL(path, origin).toString();
}

export function CopyField({ label, value }: { label: string; value: string }): ReactNode {
  const id = useId();
  const [attempt, setAttempt] = useState<
    { readonly outcome: "copied" | "manual"; readonly value: string } | undefined
  >();
  const state = attempt?.value === value ? attempt.outcome : "idle";

  async function copy(): Promise<void> {
    const copying = value;
    try {
      await navigator.clipboard.writeText(copying);
      setAttempt({ outcome: "copied", value: copying });
    } catch {
      const input = document.getElementById(id);
      if (input instanceof HTMLInputElement) input.select();
      setAttempt({ outcome: "manual", value: copying });
    }
  }

  return (
    <div>
      <label className={labelClassName} htmlFor={id}>
        {label}
      </label>
      <div className="mt-1 flex flex-col gap-2 sm:flex-row">
        <input
          className={`${inputClassName} mt-0 font-mono text-xs`}
          id={id}
          onFocus={(event) => event.currentTarget.select()}
          readOnly
          value={value}
        />
        <button className={secondaryButtonClassName} onClick={() => void copy()} type="button">
          {state === "copied" ? "Copied" : "Copy link"}
        </button>
      </div>
      <p aria-live="polite" className="mt-1 text-xs text-muted-foreground" role="status">
        {state === "copied"
          ? "Link copied."
          : state === "manual"
            ? "Copy is blocked here. The link is selected; copy it by hand."
            : ""}
      </p>
    </div>
  );
}

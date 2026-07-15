import { clsx } from "clsx";
import type { ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Merge class names the shadcn way: `clsx` flattens conditional inputs, then
 * `tailwind-merge` resolves conflicting Tailwind utilities so the last one wins.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

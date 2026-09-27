import { twMerge, type ClassNameValue } from "tailwind-merge";

/** Join Tailwind classes so a later one beats an earlier one on the same property. */
export function cn(...classes: ClassNameValue[]): string {
  return twMerge(...classes);
}

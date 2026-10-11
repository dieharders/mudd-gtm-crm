/** The warning under a template body: placeholders that match no column, which the merge leaves as-is. */
export function UnknownPlaceholders({ names, className }: { names: string[]; className?: string }) {
  if (!names.length) return null;
  return (
    <p className={`text-xs text-amber-700 ${className ?? "mt-1.5"}`}>
      {names.map((u) => `{{${u}}}`).join(", ")} match no column and will be left as-is.
    </p>
  );
}

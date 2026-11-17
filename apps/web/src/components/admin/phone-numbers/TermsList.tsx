/** The consequences a confirmation states, one sentence per line. */
export function TermsList({ terms }: { terms: string[] }) {
  return (
    <ul className="list-disc space-y-1.5 pl-5 text-sm text-muted-foreground">
      {terms.map((term) => (
        <li key={term}>{term}</li>
      ))}
    </ul>
  );
}

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

interface CapabilityBadgesProps {
  voice: boolean;
  sms: boolean;
  mms: boolean;
  /** Only shown, never used: nothing here sends or receives faxes. */
  fax?: boolean;
  className?: string;
}

/** What a number can carry, the same way in the search, the list and its page. */
export function CapabilityBadges({
  voice,
  sms,
  mms,
  fax = false,
  className,
}: CapabilityBadgesProps) {
  const names = [
    voice ? 'Voice' : null,
    sms ? 'SMS' : null,
    mms ? 'MMS' : null,
    fax ? 'Fax' : null,
  ].filter((name) => name !== null);

  return (
    <div className={cn('flex flex-wrap items-center gap-1', className)}>
      {names.length === 0 ? (
        <span className="text-muted-foreground">-</span>
      ) : (
        names.map((name) => (
          <Badge key={name} variant="secondary" className="text-xs">
            {name}
          </Badge>
        ))
      )}
    </div>
  );
}

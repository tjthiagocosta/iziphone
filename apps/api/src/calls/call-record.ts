import type { Prisma } from '@repo/db';
import type {
  CallContact,
  CallDirection,
  CallLine,
  CallRecord,
} from '@repo/dto';

/**
 * Relations every call read needs so it can be mapped to the API shape. The
 * voicemail entry is fetched as one row rather than counted: the reply only
 * says whether there is one.
 */
export const callRecordInclude = {
  user: { select: { id: true, email: true } },
  department: { select: { id: true, name: true } },
  events: {
    where: { eventType: 'VOICEMAIL_COMPLETED' },
    select: { id: true },
    take: 1,
  },
} satisfies Prisma.CallInclude;

export interface PersistedCall {
  id: string;
  conversationUuid: string;
  callerLegUuid: string | null;
  agentLegUuid: string | null;
  externalLegUuid: string | null;
  from: string;
  to: string;
  status: string;
  duration: number | null;
  recordingUrl: string | null;
  transcript: string | null;
  direction: string;
  provider: CallRecord['provider'];
  userId: string | null;
  departmentId: string | null;
  user: { id: string; email: string } | null;
  department: { id: string; name: string } | null;
  events: ReadonlyArray<{ id: string }>;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * `Call.direction` is a plain string column, so a row an import or an older
 * provider wrote can hold a value the API's enum does not cover. Anything not
 * recorded as inbound reads as outbound, which is how every caller already
 * interprets it: one odd row shows the wrong arrow instead of failing the
 * whole list, which is what a stricter reading would do.
 */
function toCallDirection(direction: string): CallDirection {
  return direction === 'inbound' ? 'inbound' : 'outbound';
}

/**
 * The API shape of a call. Prisma hands back `Date`s and every column of the
 * row; listing each field keeps the reply to what `CallRecordSchema`
 * describes, so a column added later is not published by accident.
 */
export function toCallRecordDto(
  call: PersistedCall,
  contact: CallContact | null,
  line: CallLine | null,
): CallRecord {
  return {
    id: call.id,
    conversationUuid: call.conversationUuid,
    callerLegUuid: call.callerLegUuid,
    agentLegUuid: call.agentLegUuid,
    externalLegUuid: call.externalLegUuid,
    from: call.from,
    to: call.to,
    status: call.status,
    duration: call.duration,
    recordingUrl: call.recordingUrl,
    transcript: call.transcript,
    direction: toCallDirection(call.direction),
    provider: call.provider,
    userId: call.userId,
    departmentId: call.departmentId,
    user: call.user,
    department: call.department,
    contact,
    line,
    hasVoicemail: call.events.length > 0,
    createdAt: call.createdAt.toISOString(),
    updatedAt: call.updatedAt.toISOString(),
  };
}

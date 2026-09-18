import type { Prisma } from '@repo/db';
import type {
  CallContact,
  CallDirection,
  CallLine,
  CallRecord,
  CallRecordingContext,
  CallRecordingDeletion,
  CallRecordingDeletionReason,
  CallRecordingSummary,
  Role,
} from '@repo/dto';
import { canListenToRecording } from './call-scope.js';

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
  recordings: {
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      context: true,
      duration: true,
      deletedAt: true,
      deletionReason: true,
      createdAt: true,
    },
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
  transcript: string | null;
  direction: string;
  provider: CallRecord['provider'];
  userId: string | null;
  departmentId: string | null;
  user: { id: string; email: string } | null;
  department: { id: string; name: string } | null;
  events: ReadonlyArray<{ id: string }>;
  recordings: readonly PersistedRecording[];
  createdAt: Date;
  updatedAt: Date;
}

export interface PersistedRecording {
  id: string;
  context: CallRecordingContext;
  duration: number | null;
  deletedAt: Date | null;
  deletionReason: CallRecordingDeletionReason | null;
  createdAt: Date;
}

/**
 * A recording's deletion as the API publishes it, and null while the audio is
 * still there. A row marked deleted without a reason was deleted by hand:
 * that is the only kind of deletion there was before the policy existed.
 */
export function toRecordingDeletion(
  deletedAt: Date | null,
  reason: CallRecordingDeletionReason | null,
): CallRecordingDeletion | null {
  if (deletedAt === null) {
    return null;
  }

  return { reason: reason ?? 'MANUAL', at: deletedAt.toISOString() };
}

/**
 * A recording as a call's card shows it: what it is, how long, and whether its
 * audio is still there. Nothing that names where the audio lives.
 */
function toRecordingSummary(
  recording: PersistedRecording,
): CallRecordingSummary {
  return {
    id: recording.id,
    context: recording.context,
    duration: recording.duration,
    deletion: toRecordingDeletion(
      recording.deletedAt,
      recording.deletionReason,
    ),
    createdAt: recording.createdAt.toISOString(),
  };
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
  role: Role,
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
    /*
     * A recording the reader may not hear is not mentioned at all: telling an
     * agent that the conversation was recorded, and when it was deleted, is
     * what `recordings:listen` reserves for supervisors and admins, and a
     * summary the audio route would refuse is of no use to the client either.
     */
    recordings: call.recordings
      .filter((recording) => canListenToRecording(role, recording.context))
      .map(toRecordingSummary),
    createdAt: call.createdAt.toISOString(),
    updatedAt: call.updatedAt.toISOString(),
  };
}

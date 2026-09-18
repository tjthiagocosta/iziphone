import type { CallRecordingSummary } from '@repo/dto';
import { describe, expect, test } from 'vitest';
import {
  canRequestRecording,
  deletionNotice,
  IDLE_RECORDING,
  missingVoicemailNotice,
  type RecordingPlayback,
  recordingFailure,
  recordingNoun,
  recordingPlaybackReducer,
} from './playback';

const loading: RecordingPlayback = { status: 'loading' };
const audio = new Blob(['not really audio'], { type: 'audio/mpeg' });
const ready: RecordingPlayback = { status: 'ready', audio };

const voicemail: CallRecordingSummary = {
  id: 'recording-1',
  context: 'VOICEMAIL',
  duration: 21,
  deletion: null,
  createdAt: '2026-09-18T09:30:00.000Z',
};

const callRecording: CallRecordingSummary = {
  ...voicemail,
  id: 'recording-2',
  context: 'CONFERENCE',
};

describe('recordingNoun', () => {
  test('names a voicemail and a call recording apart', () => {
    expect(recordingNoun(voicemail)).toBe('voicemail');
    expect(recordingNoun(callRecording)).toBe('call recording');
  });
});

describe('deletionNotice', () => {
  test('has nothing to say about a recording that is still there', () => {
    expect(deletionNotice(voicemail)).toBeNull();
  });

  test('says the retention policy deleted it', () => {
    expect(
      deletionNotice({
        ...voicemail,
        deletion: {
          reason: 'RETENTION_POLICY',
          at: '2026-09-18T09:31:00.000Z',
        },
      }),
    ).toBe('This voicemail was deleted by the retention policy');
  });

  test('says a call recording somebody deleted was deleted', () => {
    expect(
      deletionNotice({
        ...callRecording,
        deletion: { reason: 'MANUAL', at: '2026-09-18T09:31:00.000Z' },
      }),
    ).toBe('This call recording was deleted');
  });
});

describe('missingVoicemailNotice', () => {
  test('says nothing when the voicemail has a recording to play', () => {
    expect(missingVoicemailNotice(true, [voicemail])).toBeNull();
  });

  test('says nothing about a call that left no voicemail', () => {
    expect(missingVoicemailNotice(false, [])).toBeNull();
    expect(missingVoicemailNotice(false, [callRecording])).toBeNull();
  });

  test('explains a voicemail whose audio never became a recording', () => {
    expect(missingVoicemailNotice(true, [])).toBe(
      'No audio was kept for this voicemail',
    );
  });

  test('explains it although the call itself was recorded', () => {
    // The recording of the conversation is not the voicemail the card says
    // the caller left.
    expect(missingVoicemailNotice(true, [callRecording])).toBe(
      'No audio was kept for this voicemail',
    );
  });

  test('says nothing more once the voicemail is there but deleted', () => {
    const deleted: CallRecordingSummary = {
      ...voicemail,
      deletion: { reason: 'RETENTION_POLICY', at: '2026-09-18T10:00:00.000Z' },
    };

    expect(missingVoicemailNotice(true, [deleted])).toBeNull();
  });
});

describe('recordingFailure', () => {
  test('repeats what the API said about a recording that is gone', () => {
    expect(
      recordingFailure(
        410,
        'This recording was deleted by the retention policy',
      ),
    ).toEqual({
      status: 'failed',
      message: 'This recording was deleted by the retention policy',
    });
  });

  test.each([404, 410])(
    'says a recording that is gone is gone (%s)',
    (status) => {
      expect(recordingFailure(status)).toEqual({
        status: 'failed',
        message: 'This recording is no longer available',
      });
    },
  );

  test.each([429, 500, 502, 503, null])(
    'says a recording that did not arrive could not be loaded (%s)',
    (status) => {
      expect(recordingFailure(status)).toEqual({
        status: 'failed',
        message: 'This recording could not be loaded',
      });
    },
  );

  test('does not repeat what the API said about a failure of its own', () => {
    expect(recordingFailure(502, 'bucket unavailable').message).toBe(
      'This recording could not be loaded',
    );
  });
});

describe('recordingPlaybackReducer', () => {
  test('starts with nothing downloaded', () => {
    expect(IDLE_RECORDING).toEqual({ status: 'idle' });
    expect(canRequestRecording(IDLE_RECORDING)).toBe(true);
  });

  test('loads when the user asks to play', () => {
    expect(
      recordingPlaybackReducer(IDLE_RECORDING, { type: 'requested' }),
    ).toEqual(loading);
  });

  test('ignores a second press while the first download is running', () => {
    expect(canRequestRecording(loading)).toBe(false);
    expect(recordingPlaybackReducer(loading, { type: 'requested' })).toBe(
      loading,
    );
  });

  test('plays what was downloaded', () => {
    expect(
      recordingPlaybackReducer(loading, { type: 'loaded', audio }),
    ).toEqual(ready);
  });

  test('keeps the audio it has when asked again', () => {
    expect(canRequestRecording(ready)).toBe(false);
    expect(recordingPlaybackReducer(ready, { type: 'requested' })).toBe(ready);
  });

  test('reports a download the API refused, in the API words when it gave any', () => {
    expect(
      recordingPlaybackReducer(loading, { type: 'failed', status: 410 }),
    ).toEqual(recordingFailure(410));
    expect(
      recordingPlaybackReducer(loading, {
        type: 'failed',
        status: 410,
        message: 'This recording was deleted',
      }),
    ).toEqual({ status: 'failed', message: 'This recording was deleted' });
    expect(
      recordingPlaybackReducer(loading, { type: 'failed', status: null }),
    ).toEqual(recordingFailure(null));
  });

  test.each([502, 404, 410])(
    'tries again after any failed download (%s)',
    (status) => {
      // 404 too: a recording can reach the call after its card was drawn.
      const failed = recordingFailure(status);

      expect(canRequestRecording(failed)).toBe(true);
      expect(recordingPlaybackReducer(failed, { type: 'requested' })).toEqual(
        loading,
      );
    },
  );

  test('says so when the browser cannot play the audio, and lets the user retry', () => {
    const unplayable = recordingPlaybackReducer(ready, { type: 'unplayable' });

    expect(unplayable).toEqual({
      status: 'failed',
      message: 'This recording could not be played',
    });
    expect(canRequestRecording(unplayable)).toBe(true);
  });

  test('leaves the state alone for an answer nobody is waiting for', () => {
    expect(
      recordingPlaybackReducer(IDLE_RECORDING, { type: 'loaded', audio }),
    ).toBe(IDLE_RECORDING);
    expect(
      recordingPlaybackReducer(ready, { type: 'failed', status: 502 }),
    ).toBe(ready);
    expect(recordingPlaybackReducer(loading, { type: 'unplayable' })).toBe(
      loading,
    );
  });
});

import { describe, expect, test } from 'vitest';
import {
  canRequestVoicemail,
  IDLE_VOICEMAIL,
  type VoicemailPlayback,
  voicemailFailure,
  voicemailPlaybackReducer,
} from './playback';

const loading: VoicemailPlayback = { status: 'loading' };
const audio = new Blob(['not really audio'], { type: 'audio/mpeg' });
const ready: VoicemailPlayback = { status: 'ready', audio };

describe('voicemailFailure', () => {
  test.each([404, 410])(
    'says a voicemail that is gone is gone (%s)',
    (status) => {
      expect(voicemailFailure(status)).toEqual({
        status: 'failed',
        message: 'This voicemail is no longer available',
      });
    },
  );

  test.each([429, 500, 502, 503, null])(
    'says a voicemail that did not arrive could not be loaded (%s)',
    (status) => {
      expect(voicemailFailure(status)).toEqual({
        status: 'failed',
        message: 'This voicemail could not be loaded',
      });
    },
  );
});

describe('voicemailPlaybackReducer', () => {
  test('starts with nothing downloaded', () => {
    expect(IDLE_VOICEMAIL).toEqual({ status: 'idle' });
    expect(canRequestVoicemail(IDLE_VOICEMAIL)).toBe(true);
  });

  test('loads when the user asks to play', () => {
    expect(
      voicemailPlaybackReducer(IDLE_VOICEMAIL, { type: 'requested' }),
    ).toEqual(loading);
  });

  test('ignores a second press while the first download is running', () => {
    expect(canRequestVoicemail(loading)).toBe(false);
    expect(voicemailPlaybackReducer(loading, { type: 'requested' })).toBe(
      loading,
    );
  });

  test('plays what was downloaded', () => {
    expect(
      voicemailPlaybackReducer(loading, { type: 'loaded', audio }),
    ).toEqual(ready);
  });

  test('keeps the audio it has when asked again', () => {
    expect(canRequestVoicemail(ready)).toBe(false);
    expect(voicemailPlaybackReducer(ready, { type: 'requested' })).toBe(ready);
  });

  test('reports a download the API refused', () => {
    expect(
      voicemailPlaybackReducer(loading, { type: 'failed', status: 410 }),
    ).toEqual(voicemailFailure(410));
    expect(
      voicemailPlaybackReducer(loading, { type: 'failed', status: null }),
    ).toEqual(voicemailFailure(null));
  });

  test.each([502, 404, 410])(
    'tries again after any failed download (%s)',
    (status) => {
      // 404 too: a recording can reach the timeline after its card was drawn.
      const failed = voicemailFailure(status);

      expect(canRequestVoicemail(failed)).toBe(true);
      expect(voicemailPlaybackReducer(failed, { type: 'requested' })).toEqual(
        loading,
      );
    },
  );

  test('says so when the browser cannot play the audio, and lets the user retry', () => {
    const unplayable = voicemailPlaybackReducer(ready, { type: 'unplayable' });

    expect(unplayable).toEqual({
      status: 'failed',
      message: 'This voicemail could not be played',
    });
    expect(canRequestVoicemail(unplayable)).toBe(true);
  });

  test('leaves the state alone for an answer nobody is waiting for', () => {
    expect(
      voicemailPlaybackReducer(IDLE_VOICEMAIL, { type: 'loaded', audio }),
    ).toBe(IDLE_VOICEMAIL);
    expect(
      voicemailPlaybackReducer(ready, { type: 'failed', status: 502 }),
    ).toBe(ready);
    expect(voicemailPlaybackReducer(loading, { type: 'unplayable' })).toBe(
      loading,
    );
  });
});

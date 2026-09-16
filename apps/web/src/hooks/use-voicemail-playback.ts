'use client';

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { fetchVoicemail } from '@/lib/api/calls';
import { ApiError } from '@/lib/api/client';
import {
  canRequestVoicemail,
  IDLE_VOICEMAIL,
  type VoicemailPlayback,
  voicemailPlaybackReducer,
} from '@/lib/voicemail/playback';

export interface UseVoicemailPlaybackReturn {
  playback: VoicemailPlayback;
  /** What the audio element plays; null until there is audio to play. */
  src: string | null;
  /** Downloads the voicemail. Does nothing while one is loading or loaded. */
  play: () => void;
  /** The audio element could not play what was downloaded. */
  reportUnplayable: () => void;
}

/**
 * One call's voicemail, downloaded from the API when the user asks for it.
 * An instance belongs to one call for its whole life; `VoicemailPlayer` keys
 * itself on the call so that a changed id is a new instance.
 *
 * The audio is fetched rather than streamed by the element: the API only
 * serves it to a session, and a fetch can tell a voicemail that is gone from
 * one that failed to arrive, where an element only reports that it has no
 * sound.
 */
export function useVoicemailPlayback(
  conversationUuid: string,
): UseVoicemailPlaybackReturn {
  const [playback, dispatch] = useReducer(
    voicemailPlaybackReducer,
    IDLE_VOICEMAIL,
  );
  const [src, setSrc] = useState<string | null>(null);
  const downloadRef = useRef<AbortController | null>(null);

  const audio = playback.status === 'ready' ? playback.audio : null;

  /*
   * An object URL holds the whole recording in memory until it is revoked, so
   * it lives exactly as long as this effect: made when there is audio to play,
   * revoked when that audio is dropped and when the card goes away.
   */
  useEffect(() => {
    if (!audio) {
      return;
    }
    const url = URL.createObjectURL(audio);
    setSrc(url);
    return () => {
      URL.revokeObjectURL(url);
      setSrc(null);
    };
  }, [audio]);

  // A card that goes away mid-download has nobody left to play it to.
  useEffect(() => () => downloadRef.current?.abort(), []);

  const play = useCallback(() => {
    // The ref catches a second press before the first has been rendered.
    if (downloadRef.current || !canRequestVoicemail(playback)) {
      return;
    }

    const download = new AbortController();
    downloadRef.current = download;
    dispatch({ type: 'requested' });

    void (async () => {
      try {
        const downloaded = await fetchVoicemail(
          conversationUuid,
          download.signal,
        );
        dispatch({ type: 'loaded', audio: downloaded });
      } catch (cause) {
        dispatch({
          type: 'failed',
          status: cause instanceof ApiError ? cause.status : null,
        });
      } finally {
        downloadRef.current = null;
      }
    })();
  }, [conversationUuid, playback]);

  const reportUnplayable = useCallback(
    () => dispatch({ type: 'unplayable' }),
    [],
  );

  return { playback, src, play, reportUnplayable };
}

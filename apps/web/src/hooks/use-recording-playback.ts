'use client';

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { fetchRecording } from '@/lib/api/calls';
import { ApiError } from '@/lib/api/client';
import {
  canRequestRecording,
  IDLE_RECORDING,
  type RecordingPlayback,
  recordingPlaybackReducer,
} from '@/lib/recording/playback';

export interface UseRecordingPlaybackReturn {
  playback: RecordingPlayback;
  /** What the audio element plays; null until there is audio to play. */
  src: string | null;
  /** Downloads the recording. Does nothing while one is loading or loaded. */
  play: () => void;
  /** The audio element could not play what was downloaded. */
  reportUnplayable: () => void;
}

/**
 * One recording of one call, downloaded from the API when the user asks for
 * it. An instance belongs to one recording for its whole life; `RecordingPlayer`
 * keys itself on the recording so that a changed id is a new instance.
 *
 * The audio is fetched rather than streamed by the element: the API only
 * serves it to a session, and a fetch can tell a recording that is gone, and
 * why, from one that failed to arrive, where an element only reports that it
 * has no sound.
 */
export function useRecordingPlayback(
  conversationUuid: string,
  recordingId: string,
): UseRecordingPlaybackReturn {
  const [playback, dispatch] = useReducer(
    recordingPlaybackReducer,
    IDLE_RECORDING,
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
    if (downloadRef.current || !canRequestRecording(playback)) {
      return;
    }

    const download = new AbortController();
    downloadRef.current = download;
    dispatch({ type: 'requested' });

    void (async () => {
      try {
        const downloaded = await fetchRecording(
          conversationUuid,
          recordingId,
          download.signal,
        );
        dispatch({ type: 'loaded', audio: downloaded });
      } catch (cause) {
        dispatch({
          type: 'failed',
          status: cause instanceof ApiError ? cause.status : null,
          message: cause instanceof ApiError ? cause.message : undefined,
        });
      } finally {
        downloadRef.current = null;
      }
    })();
  }, [conversationUuid, recordingId, playback]);

  const reportUnplayable = useCallback(
    () => dispatch({ type: 'unplayable' }),
    [],
  );

  return { playback, src, play, reportUnplayable };
}

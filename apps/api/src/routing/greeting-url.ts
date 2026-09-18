/**
 * Where a department's uploaded voicemail greeting is served. The routing
 * cache carries this URL for the call controller to `<Play>`, the department
 * response carries it for the admin console, and the greeting routes answer
 * it, so the rule lives in one place and the settings row stores only the id.
 */
export const GREETING_MEDIA_PATH = '/media/greetings';

export function departmentGreetingUrl(
  publicUrl: string,
  greetingId: string,
): string {
  return `${publicUrl}${GREETING_MEDIA_PATH}/${encodeURIComponent(greetingId)}`;
}

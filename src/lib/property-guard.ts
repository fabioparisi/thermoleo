/**
 * Pure guard for the multi-property rooms fetch race.
 *
 * The dashboard polls /api/rooms every 60s and re-fetches on every property
 * switch. A reply for the PREVIOUS property can land after the user already
 * switched homes — if the client applied it, the Campomarino tab would render
 * Milano's fancoils (and vice-versa). This decides whether a landed reply is
 * still valid to apply.
 *
 * Accept ONLY when both hold:
 *  - the reply's own `property` (echoed by the server) matches the property the
 *    fetch was issued for, AND
 *  - that property is still the one currently selected when the reply lands.
 *
 * A reply with no `property` field is treated as a legacy/unknown response and
 * is accepted only if the request- and current-property already agree (so it
 * can't sneak the wrong home in, but won't break a hypothetical old endpoint).
 */
export function shouldApplyRoomsReply(
  replyProperty: string | null | undefined,
  requestedProperty: string,
  currentProperty: string,
): boolean {
  if (replyProperty != null && replyProperty !== requestedProperty) return false;
  if (requestedProperty !== currentProperty) return false;
  return true;
}

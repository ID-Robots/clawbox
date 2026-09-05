/**
 * The most audio the chat's transcribe route accepts in one upload.
 *
 * A phone's microphone blob for a long question is a few hundred KB; the
 * cloud proxy refuses uploads of ~9 MB with its own 413 anyway, so nothing
 * that could have been transcribed is lost by saying 8. Kept here rather
 * than in the route module, which may export handlers and Next's config
 * keys only (the webpack build's route type check refuses anything else).
 */
export const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

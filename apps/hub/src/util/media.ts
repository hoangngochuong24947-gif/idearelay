import { extname, basename } from 'node:path';

/** Audio extensions accepted by the consume folder. */
export const AUDIO_EXTENSIONS: readonly string[] = [
  '.m4a',
  '.mp3',
  '.wav',
  '.aac',
  '.caf',
  '.ogg',
  '.flac',
  '.opus',
];

const MIME_BY_EXT: Record<string, string> = {
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.aac': 'audio/aac',
  '.caf': 'audio/x-caf',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.opus': 'audio/opus',
};

export function mimeForPath(path: string): string {
  return MIME_BY_EXT[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * A path only counts as a finalized audio file when it is not a hidden/temp
 * artifact. Mobile uploads land as `.part` and are atomically `mv`'d, so partial
 * files never match (spec §11; stack-survey §二 paperless-ngx consume folder).
 */
export function isFinalizedAudioFile(path: string): boolean {
  const name = basename(path);
  if (name.startsWith('.')) return false;
  const lower = name.toLowerCase();
  if (lower.endsWith('.part') || lower.endsWith('.tmp')) return false;
  return AUDIO_EXTENSIONS.includes(extname(lower));
}

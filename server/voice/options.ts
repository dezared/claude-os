// The "voice" key of config/settings.json. Claude can edit that file by hand: what does not fit falls back to the default.
import { VOICE_LANGUAGES, VOICE_MODEL_IDS, type VoiceLanguage, type VoiceModelId, type VoiceOptions } from '../../shared/voice.ts';

export const DEFAULT_VOICE_MODEL: VoiceModelId = 'whisper-small';

const isModel = (v: unknown): v is VoiceModelId => VOICE_MODEL_IDS.includes(v as VoiceModelId);
const isLanguage = (v: unknown): v is VoiceLanguage => VOICE_LANGUAGES.includes(v as VoiceLanguage);

// The profile's language is the user's speech unless the user picked another one.
export function voiceOptions(raw: unknown, profileLanguage: string | null): VoiceOptions {
  const v = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const fromProfile = isLanguage(profileLanguage) && profileLanguage !== 'auto' ? profileLanguage : 'en';
  return { model: isModel(v.model) ? v.model : DEFAULT_VOICE_MODEL, language: isLanguage(v.language) ? v.language : fromProfile };
}

export function voicePatchError(patch: Partial<VoiceOptions>): string | null {
  if (patch.model !== undefined && !isModel(patch.model)) return `model: one of ${VOICE_MODEL_IDS.join(', ')}`;
  if (patch.language !== undefined && !isLanguage(patch.language)) return `language: one of ${VOICE_LANGUAGES.join(', ')}`;
  return null;
}

// The jargon prompt comes in Russian and English only: detection keeps the Russian one for a Russian profile.
export function promptLanguage(language: VoiceLanguage, profileLanguage: string | null): 'ru' | 'en' {
  return language === 'ru' || (language === 'auto' && profileLanguage === 'ru') ? 'ru' : 'en';
}

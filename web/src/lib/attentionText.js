import { ATTENTION_LABELS } from './format.js';

/**
 * Attention-flag wording, composed on the client.
 *
 * The server sends each flag with a stable `code` plus structured `params`
 * (a streak count, a stretch in minutes, a threshold). It also sends an English
 * `detail` sentence, but that is only a fallback for API consumers — rendering it
 * directly would put an English sentence inside an otherwise translated board.
 * Composing here keeps the numbers machine-readable and the prose translatable.
 */

export function attentionFlagLabel(t, flag) {
  const key = ATTENTION_LABELS[flag?.code];
  return key ? t(key) : (flag?.label ?? '');
}

export function attentionFlagDetail(t, tn, flag) {
  const params = flag?.params ?? {};
  switch (flag?.code) {
    case 'repeat_misses':
      return tn(params.streak ?? flag.streak ?? 2, 'attentionFlag.repeat_missesDetail');
    case 'long_session':
      return t('attentionFlag.long_sessionDetail', {
        minutes: params.minutes ?? Math.round((flag.stretchSeconds ?? 0) / 60),
        threshold: params.threshold ?? 0,
      });
    case 'offline_mid_break':
      return t('attentionFlag.offline_mid_breakDetail');
    case 'offline_mid_session':
      return t('attentionFlag.offline_mid_sessionDetail', { seconds: params.seconds ?? 0 });
    default:
      // An unrecognised code from a newer server: show its own sentence rather
      // than an empty line.
      return flag?.detail ?? '';
  }
}

/** One-line summary for the attention list: the worst flag's label, or all of them. */
export function attentionHeadline(t, item) {
  const codes = item?.codes ?? [];
  if (codes.length <= 1) {
    const key = ATTENTION_LABELS[codes[0]];
    return key ? t(key) : (item?.headline ?? '');
  }
  return codes.map((code) => (ATTENTION_LABELS[code] ? t(ATTENTION_LABELS[code]) : code)).join(' · ');
}

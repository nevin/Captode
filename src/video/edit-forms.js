// The form for the chosen edit on the video page: one small builder per kind of edit,
// made from a few shared pieces (a field, a row of choices, a switch, a slider). Each
// returns HTML; edits-panel.js puts it in place and handles what is changed in it.
// Text typed by the user (captions, callouts) is never put in this HTML: the panel
// sets it on the text box afterwards.

import { RATES, CALLOUT_COLOURS, CALLOUT_KINDS, LAYER_POSITIONS, CAPTION_FONTS } from '../lib/video-edits.js';
import { t } from '../lib/i18n.js';
import { canTranslate, languageOptions, languageChoices } from '../lib/translate.js';

export const round = (v) => Math.round(v * 10) / 10;

// ---------- shared pieces ----------

const field = (label, html) => `<label class="field"><span>${label}</span>${html}</label>`;
const hint = (text) => `<p class="muted small">${text}</p>`;
const actions = (html) => `<div class="row ed-actions">${html}</div>`;
const button = (attrs, label, tip = '') => `<button type="button" class="btn" ${attrs}${tip ? ` data-tip="${tip}"` : ''}>${label}</button>`;

/** A box for the edit's text; its value is set afterwards, not written into the HTML. */
const textBox = (label, placeholder, rows = 2, attrs = '') =>
  `<label class="field"><span>${label}</span><textarea rows="${rows}"${attrs} data-k="text" placeholder="${placeholder}"></textarea></label>`;

/** A switch for `key` (data-k, or data-cs for how every caption looks), with an optional hint under its label. */
const toggle = (label, key, on, { hint: small = '', attr = 'k' } = {}) =>
  `<label class="toggle"><span>${label}${small ? `<small>${small}</small>` : ''}</span><input type="checkbox" data-${attr}="${key}" ${on ? 'checked' : ''}></label>`;

/** A slider for `key`, its value shown in bold after the label. */
const slider = (label, shown, key, min, max, step, value) =>
  field(`${label} <b>${shown}</b>`, `<input type="range" data-k="${key}" min="${min}" max="${max}" step="${step}" value="${value}">`);

/** A row of choices for `key`: [[value, label, extra attributes?]], `current` chosen. */
function seg(key, options, current, cls = 'seg') {
  const buttons = options.map(([val, label, extra]) => {
    const on = String(val) === String(current);
    return `<button type="button" data-v="${val}" role="radio" aria-checked="${on}" class="${on ? 'on' : ''}"${extra ? ` ${extra}` : ''}>${label}</button>`;
  });
  return `<div class="${cls}" data-seg="${key}" role="radiogroup">${buttons.join('')}</div>`;
}

const SIZES = [[1, 'S'], [2, 'M'], [3, 'L']];
const swatch = (c) => `<span class="ed-swatch" style="background:${c}"></span>`;
/** Colour choices: `first`, then the callout colours not among them, up to `count` in all. */
const colours = (first, count) => [...first, ...CALLOUT_COLOURS.filter((c) => !first.some((f) => f.toLowerCase() === c.toLowerCase())).slice(0, count - first.length)];
const colourSeg = (key, list, current) => field(t('vlayer_text_colour'), seg(key, list.map((c) => [c, swatch(c), `aria-label="${c}" title="${c}"`]), current, 'seg ed-swatches'));
const fade = (x) => slider(t('vlayer_fade'), x.fade ? `${x.fade.toFixed(1)} s` : t('video_off'), 'fade', 0, 3, 0.1, x.fade);
const volume = (x) => slider(t('vlayer_volume'), `${Math.round(x.volume * 100)}%`, 'volume', 0, 2, 0.05, x.volume);

/** From or To, with a button to set it at the playhead. */
const timeField = (k, label, v) => field(label, `<div class="with-btn"><input type="number" data-k="${k}" min="0" step="0.1" value="${round(v)}"><button type="button" class="btn ghost icon" data-now="${k}" data-tip="${t('edit_at_playhead')}"><svg class="i" viewBox="0 0 24 24"><path d="M12 3v18M7 8l5-5 5 5"/></svg></button></div>`);

// ---------- one builder per kind ----------
// Each takes the edit and `c`: { edits, meta, next (the caption after it), reviewCaptions }.

const wholeToggle = (x) => toggle(t('edit_whole_toggle'), 'whole', x.whole);

function speeds(x) {
  return field(t('edit_speed'), seg('rate', RATES.map((r) => [r, `${r}×`]), x.rate))
    + toggle(t('edit_speed_ease'), 'ease', x.ease)
    + hint(t('edit_speed_hint'));
}

function zooms(x, c) {
  return slider(t('edit_zoom'), `${Math.round(x.scale * 10) / 10}×`, 'scale', 1.1, 4, 0.1, x.scale)
    // Following the pointer needs where it went, kept by tab recordings.
    + (c.meta.moves?.length || x.follow ? toggle(t('zoom_follow'), 'follow', x.follow, { hint: t('zoom_follow_hint') }) : '')
    + hint(t('edit_zoom_hint'));
}

function blurs(x) {
  return wholeToggle(x)
    + field(t('edit_blur_style'), seg('mode', ['blur', 'pixelate', 'box'].map((m) => [m, t(`edit_blur_${m}`)]), x.mode))
    + (x.mode !== 'box' ? slider(t('edit_strength'), x.strength, 'strength', 1, 10, 1, x.strength) : '')
    + hint(t('edit_draw_hint'));
}

function callouts(x) {
  let html = wholeToggle(x)
    + field(t('edit_callout_kind'), seg('kind', CALLOUT_KINDS.map((k) => [k, t(`edit_callout_${k}`)]), x.kind, 'seg seg-wrap'));
  if (x.kind === 'text') html += textBox(t('edit_text'), t('edit_text_placeholder'));
  if (x.kind === 'step') html += textBox(t('edit_step_label'), '1', 1, ' maxlength="3"');
  if (x.kind !== 'spot') {
    html += `<div class="field"><span>${t('edit_colour')}</span><div class="swatches ed-colours">${CALLOUT_COLOURS.map((col) => `<button type="button" data-colour="${col}" aria-pressed="${col === x.color}" style="background:${col}" aria-label="${col}"></button>`).join('')}</div></div>`;
    html += field(t('edit_size'), seg('size', SIZES, x.size));
  }
  return html + hint(t('edit_draw_hint'));
}

/** How every caption looks: font, colour, band, place and the word highlight. */
function captionLook(cs) {
  const fonts = Object.keys(CAPTION_FONTS).map((f) => [f, 'Aa', `title="${t(`cap_font_${f}`)}" aria-label="${t(`cap_font_${f}`)}" style="font-family:${CAPTION_FONTS[f].replace(/"/g, "'")}"`]);
  return `<div class="ed-cap-style"><b>${t('cap_style')}</b>`
    + field(t('cap_font'), seg('cs-font', fonts, cs.font))
    + colourSeg('cs-color', colours(['#ffffff', '#000000', '#ffd60a'], 7), cs.color)
    + field(t('cap_band'), seg('cs-band', ['dark', 'light', 'outline', 'none'].map((b) => [b, t(`cap_band_${b}`)]), cs.band, 'seg seg-wrap'))
    + field(t('cap_place'), seg('cs-place', ['bottom', 'middle', 'top'].map((b) => [b, t(`thumb_${b}`)]), cs.place))
    + toggle(t('cap_highlight'), 'highlight', cs.highlight, { hint: t('cap_highlight_hint'), attr: 'cs' })
    + '</div>';
}

/** Subtitles in the file: burnt in or kept as a track, in the captions' language and others. */
function subtitleFiles(edits) {
  const cs = edits.captionStyle;
  const none = t('subs_lang_none');
  let html = `<div class="ed-cap-style"><b>${t('subs_title')}</b>`
    + toggle(t('subs_burn'), 'burn', cs.burn, { hint: t('subs_burn_hint'), attr: 'cs' })
    + toggle(t('subs_embed'), 'embed', cs.embed, { hint: t('subs_embed_hint'), attr: 'cs' })
    + `<label class="field"><span>${t('subs_lang')}</span><select data-sublang="">${languageChoices(cs.lang, none)}</select></label>`;
  for (const tr of edits.subtitleTracks) {
    const n = edits.captions.filter((c) => tr.texts[c.id]?.trim()).length;
    html += `<div class="row sub-track"><select data-sublang="${tr.id}" aria-label="${t('subs_track_lang')}">${languageChoices(tr.lang === 'und' ? '' : tr.lang, none)}</select><span class="muted small">${t('subs_track_count', [String(n), String(edits.captions.length)])}</span><button type="button" class="btn ghost icon" data-subdel="${tr.id}" aria-label="${t('subs_track_remove')}" title="${t('subs_track_remove')}"><svg class="i" viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg></button></div>`;
  }
  if (edits.subtitleTracks.length < 8) {
    html += actions(button('data-subfile', t('subs_add_file'), t('subs_add_file_tip')));
    if (canTranslate) html += `<label class="field"><span>${t('subs_add_translation')}</span><select data-subtranslate>${languageOptions()}</select></label>`;
  }
  return html + '</div>';
}

function captions(x, c) {
  let html = textBox(t('edit_text'), t('edit_caption_placeholder'))
    + field(t('edit_size'), seg('size', SIZES, x.size))
    + hint(t('edit_caption_hint'))
    + captionLook(c.edits.captionStyle)
    + actions(button(`data-join ${c.next ? '' : 'disabled'}`, t('cap_join'), t('cap_join_tip'))
      + (c.reviewCaptions ? button('data-review', t('cap_review'), t('cap_review_tip')) : '')
      + button('data-fillers', t('fillers_find'), t('fillers_tip')))
    + actions(button('data-subs="srt"', t('edit_subtitles_srt'), t('edit_subtitles_tip')) + button('data-subs="vtt"', t('edit_subtitles_vtt'), t('edit_subtitles_tip')));
  html += canTranslate
    ? `<label class="field"><span>${t('translate_captions')}</span><select data-translate>${languageOptions()}</select></label>`
    : hint(t('translate_not_here'));
  return html + subtitleFiles(c.edits);
}

/** Words over the picture. */
const textLayer = (x) => textBox(t('edit_text'), t('vlayer_text_default'))
  + colourSeg('color', colours(['#ffffff', '#000000'], 7), x.color)
  + field(t('vlayer_text_bg'), seg('bg', [['dark', t('vlayer_bg_dark')], ['light', t('vlayer_bg_light')], ['none', t('vlayer_bg_none')]], x.bg));

/** A voiceover, or other sound on its own: heard, not seen. */
const soundLayer = (x) => volume(x) + fade(x) + hint(t('vo_hint'));

/** Where a video or text layer sits on the picture, and how it looks. */
function placedLayer(x) {
  const isVideo = (x.kind || 'video') === 'video';
  const arrows = { tl: '↖', bl: '↙', c: '●', tr: '↗', br: '↘' }; // left side, middle, right side
  const positions = Object.keys(arrows).filter((p) => LAYER_POSITIONS.includes(p)).map((p) => [p, arrows[p], `aria-label="${t(`vlayer_pos_${p}`)}" title="${t(`vlayer_pos_${p}`)}"`]);
  const borderName = (c) => (c === 'none' ? t('vlayer_border_none') : c);
  const borders = ['none', ...colours(['#ffffff', '#000000'], 6)].map((c) => [c, c === 'none' ? '∅' : swatch(c), `aria-label="${borderName(c)}" title="${borderName(c)}"`]);
  return field(t('vlayer_position'), seg('pos', positions, x.pos))
    + slider(t('edit_size'), `${Math.round(x.size * 100)}%`, 'size', 0.1, 1, 0.05, x.size)
    + field(t('vlayer_shape'), seg('shape', [['rect', t('vlayer_shape_rect')], ['circle', t('vlayer_shape_circle')]], x.shape))
    + (isVideo && x.sound ? volume(x) : '')
    + slider(t('vlayer_opacity'), `${Math.round(x.opacity * 100)}%`, 'opacity', 0.1, 1, 0.05, x.opacity)
    + fade(x)
    + field(t('vlayer_border'), seg('border', borders, x.border, 'seg ed-swatches'))
    + toggle(t('vlayer_shadow'), 'shadow', x.shadow)
    + toggle(t('vlayer_move'), 'move', x.move, { hint: t('vlayer_move_hint') })
    + (x.move ? actions(`<button type="button" class="btn" data-goto="start">${t('vlayer_go_start')}</button><button type="button" class="btn" data-goto="end">${t('vlayer_go_end')}</button>`) : '')
    + (isVideo ? field(t('vlayer_offset'), `<input type="number" data-k="offset" min="0" step="0.1" value="${round(x.offset)}">`) : '')
    + hint(t('vlayer_hint'));
}

function layers(x) {
  if (x.kind === 'sound') return soundLayer(x);
  return (x.kind === 'text' ? textLayer(x) : '') + placedLayer(x);
}

const FORMS = {
  cuts: () => hint(t('edit_cut_hint')),
  mutes: () => hint(t('edit_mute_hint')),
  speeds, zooms, blurs, callouts, captions, layers,
};

/**
 * The whole form for edit `x` of `kind`: its name, its times (unless it lasts the whole
 * video), the kind's own fields, then Split and Delete. `c`: { colour, name, at (the
 * playhead), edits, meta, next, reviewCaptions }.
 */
export function editForm(kind, x, c) {
  const canSplit = !x.whole && c.at >= x.from + 0.1 && c.at <= x.to - 0.1;
  return `<div class="ed-head"><span class="ed-dot" style="background:${c.colour}"></span><b>${c.name}</b></div>`
    + (x.whole ? '' : `<div class="grid2">${timeField('from', t('edit_from'), x.from)}${timeField('to', t('edit_to'), x.to)}</div>`)
    + (FORMS[kind]?.(x, c) || '')
    + actions(`${x.whole ? '' : `<button type="button" class="btn" data-split ${canSplit ? '' : 'disabled'} data-tip="${t('edit_split_tip')}">${t('edit_split')}</button>`}<button type="button" class="btn danger" data-del>${t('edit_delete')}</button>`);
}

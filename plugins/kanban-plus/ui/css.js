// The board's own styles: Tailwind is not built for plugins. Colours are the theme's variables, so the light theme follows;
// motion uses the app's easing and stops under reduced motion.
export const CSS = `
.kp-app { display: flex; flex: 1; min-height: 0; }
.kp-main { display: flex; flex-direction: column; flex: 1; min-width: 0; min-height: 0; }
.kp-pad { padding: 20px; }
.kp-side { display: flex; flex: none; flex-direction: column; gap: 6px; width: 14rem; padding: 12px 10px; border-right: 1px solid var(--color-line2); overflow-y: auto; }
.kp-side-head { display: flex; align-items: center; gap: 8px; padding: 2px 8px 6px; font-size: 12px; font-weight: 500; color: var(--color-dim); }
.kp-side-list { display: flex; flex-direction: column; gap: 2px; margin: 0; padding: 0; list-style: none; }
.kp-side-item { display: flex; width: 100%; align-items: center; gap: 8px; padding: 6px 8px; border: 1px solid transparent; border-radius: 8px; font-size: 13px; text-align: left; color: var(--color-soft); transition: background-color .15s var(--ease-ui), border-color .15s var(--ease-ui), color .15s var(--ease-ui), transform .12s var(--ease-ui); }
.kp-side-item:hover { color: var(--color-fg); background: color-mix(in srgb, var(--color-fg) 6%, transparent); }
.kp-side-item:active { transform: scale(.985); }
.kp-side-item.kp-on { color: var(--color-fg); background: color-mix(in srgb, var(--color-fg) 10%, transparent); }
.kp-side-item.kp-over { border-color: var(--color-accent); background: var(--color-accent-bg); }
.kp-side-item:focus-visible { outline: 2px solid var(--color-accent); outline-offset: -1px; }
.kp-side-icon { flex: none; color: var(--color-dim); transition: color .15s var(--ease-ui); }
.kp-side-item.kp-on .kp-side-icon { color: var(--color-accent); }
.kp-side-ask { align-self: stretch; justify-content: flex-start; margin-top: 4px; }
.kp-header { display: flex; flex-direction: column; border-bottom: 1px solid var(--color-line2); }
.kp-header-top { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 10px 20px 6px; }
.kp-title-box { display: flex; align-items: baseline; gap: 10px; min-width: 0; }
.kp-title { display: flex; align-items: center; gap: 8px; min-width: 0; max-width: 320px; margin: 0; font-size: 15px; font-weight: 500; color: var(--color-fg); }
.kp-goal { max-width: 28rem; font-size: 12px; }
.kp-select { width: 9.5rem; font-size: 12px; }
.kp-select-wide { width: 13rem; font-size: 12px; }
.kp-push { margin-left: auto; }
.kp-dim { color: var(--color-dim); }
.kp-small { font-size: 11px; }
.kp-mono, .kp-id { font-family: var(--font-mono, ui-monospace, monospace); }
.kp-truncate { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kp-filters { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 2px 20px 10px; }
.kp-search { display: flex; align-items: center; gap: 6px; color: var(--color-dim); }
.kp-search input { width: 15rem; height: 28px; font-size: 12px; }
.kp-chips { display: inline-flex; gap: 2px; padding: 2px; border: 1px solid var(--color-line); border-radius: 8px; }
.kp-chip { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 22px; border-radius: 6px; color: var(--color-dim); transition: background-color .15s var(--ease-ui), color .15s var(--ease-ui), transform .15s var(--ease-ui); }
.kp-chip:hover { color: var(--color-fg); background: color-mix(in srgb, var(--color-fg) 8%, transparent); }
.kp-chip:active { transform: scale(.94); }
.kp-chip.kp-on { color: var(--color-fg); background: color-mix(in srgb, var(--color-fg) 14%, transparent); }
.kp-view { display: flex; flex: 1; min-height: 0; flex-direction: column; }
.kp-board { position: relative; display: grid; flex: 1; min-height: 0; grid-auto-flow: column; grid-auto-columns: minmax(14rem, 1fr); gap: 10px; padding: 12px; overflow-x: auto; overflow-y: hidden; }
.kp-column { display: flex; flex-direction: column; min-height: 0; border: 1px solid var(--color-line2); border-radius: 12px; background: color-mix(in srgb, var(--color-fg) 2%, transparent); transition: background-color .15s var(--ease-ui), border-color .15s var(--ease-ui); }
.kp-column.kp-over, .kp-section.kp-over { border-color: color-mix(in srgb, var(--color-fg) 22%, transparent); background: color-mix(in srgb, var(--color-fg) 5%, transparent); }
.kp-column-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 12px; font-size: 12px; font-weight: 500; color: var(--color-soft); }
.kp-column-list { display: flex; flex: 1; min-height: 0; flex-direction: column; gap: 6px; overflow: auto; padding: 0 8px 8px; list-style: none; margin: 0; }
.kp-column-list > li { display: flex; flex-direction: column; gap: 6px; }
.kp-empty { padding: 8px 4px; font-size: 12px; color: var(--color-dim); }
.kp-drop-line { height: 2px; margin: 0 4px; border-radius: 2px; background: var(--color-accent); animation: kp-in .15s var(--ease-ui); }
.kp-tile { cursor: pointer; padding: 8px 10px; text-align: left; border: 1px solid var(--color-line2); border-radius: 9px; background: color-mix(in srgb, var(--color-fg) 5%, var(--color-card)); transition: border-color .15s var(--ease-ui), background-color .15s var(--ease-ui), transform .12s var(--ease-ui), opacity .15s var(--ease-ui); }
.kp-tile:hover { border-color: color-mix(in srgb, var(--color-fg) 20%, transparent); background: color-mix(in srgb, var(--color-fg) 8%, var(--color-card)); }
.kp-tile:active { transform: scale(.985); }
.kp-tile:focus-visible, .kp-row:focus-visible { outline: 2px solid var(--color-accent); outline-offset: -1px; }
.kp-tile.kp-dragging { opacity: .4; }
.kp-tile-head { display: flex; align-items: center; gap: 6px; margin-bottom: 2px; font-size: 11px; color: var(--color-dim); }
.kp-tile-title { font-size: 13px; color: var(--color-fg); overflow-wrap: anywhere; }
.kp-tile-foot { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin-top: 6px; font-size: 11px; color: var(--color-dim); }
.kp-meta { display: inline-flex; align-items: center; gap: 4px; min-width: 0; }
.kp-type { display: inline-flex; }
.kp-type-raw { display: inline-block; max-width: 7rem; font-size: 10.5px; line-height: 17px; color: var(--color-dim); }
.kp-type-task { color: var(--color-c-blue); } .kp-type-bug { color: var(--color-bad); } .kp-type-story { color: var(--color-ok); } .kp-type-epic { color: var(--color-c-violet); } .kp-type-chore { color: var(--color-dim); }
.kp-prio { display: inline-flex; }
.kp-prio-low { color: var(--color-dim); } .kp-prio-normal { color: var(--color-muted); } .kp-prio-high { color: var(--color-warn); } .kp-prio-urgent { color: var(--color-bad); }
.kp-labels { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
.kp-label { padding: 0 6px; font-size: 10.5px; line-height: 17px; border-radius: 5px; color: var(--color-soft); background: color-mix(in srgb, var(--color-c-blue) 18%, transparent); }
.kp-points { min-width: 18px; padding: 0 5px; font-size: 10.5px; line-height: 17px; text-align: center; border-radius: 9px; color: var(--color-soft); background: color-mix(in srgb, var(--color-fg) 10%, transparent); }
.kp-who { display: inline-flex; align-items: center; gap: 4px; max-width: 9rem; padding: 0 6px; border-radius: 5px; color: var(--color-soft); background: var(--color-accent-bg); }
.kp-who svg { color: var(--color-accent); flex: none; }
.kp-level { padding: 0 5px; border-radius: 5px; font-size: 10.5px; }
.kp-level-user { color: var(--color-ok); background: color-mix(in srgb, var(--color-ok) 14%, transparent); }
.kp-level-root { color: var(--color-warn); background: color-mix(in srgb, var(--color-warn) 14%, transparent); }
.kp-working { animation: kp-pulse 1.4s ease-in-out infinite; }
.kp-list { position: relative; display: flex; flex: 1; min-height: 0; flex-direction: column; gap: 10px; padding: 12px 20px; overflow: auto; }
.kp-section { border: 1px solid var(--color-line2); border-radius: 12px; transition: background-color .15s var(--ease-ui), border-color .15s var(--ease-ui); }
.kp-section-head { display: flex; align-items: center; gap: 10px; padding: 6px 10px; font-size: 12px; }
.kp-section-toggle { display: flex; align-items: center; gap: 6px; min-width: 0; font-weight: 500; color: var(--color-soft); }
.kp-chevron { transition: transform .2s var(--ease-ui); }
.kp-chevron.kp-open { transform: rotate(90deg); }
.kp-rows { display: flex; flex-direction: column; gap: 2px; padding: 0 6px 6px; margin: 0; list-style: none; }
.kp-row { display: flex; align-items: center; gap: 8px; padding: 5px 8px; border-radius: 7px; font-size: 12.5px; cursor: pointer; transition: background-color .12s var(--ease-ui); }
.kp-row:hover { background: color-mix(in srgb, var(--color-fg) 6%, transparent); }
.kp-row .kp-labels { margin-top: 0; }
.kp-row-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-fg); }
.kp-col-tag { padding: 0 6px; border-radius: 5px; font-size: 10.5px; color: var(--color-muted); background: color-mix(in srgb, var(--color-fg) 7%, transparent); }
.kp-col-doing, .kp-col-polish { color: var(--color-accent); background: var(--color-accent-bg); }
.kp-col-done { color: var(--color-ok); }
.kp-detail { display: grid; grid-template-columns: minmax(0, 1fr) 17rem; gap: 20px; }
.kp-detail-main { display: flex; min-width: 0; flex-direction: column; gap: 12px; }
.kp-detail-side { display: flex; flex-direction: column; gap: 12px; }
.kp-title-edit { width: 100%; resize: none; padding: 4px 6px; margin: -4px -6px 0; font-size: 18px; font-weight: 500; color: var(--color-fg); background: transparent; border: 1px solid transparent; border-radius: 8px; transition: border-color .15s var(--ease-ui); field-sizing: content; }
.kp-title-edit:hover { border-color: var(--color-line2); }
.kp-title-edit:focus { outline: none; border-color: var(--color-line); background: color-mix(in srgb, var(--color-fg) 3%, transparent); }
.kp-desc { min-height: 3.5rem; padding: 8px 10px; font-size: 13px; color: var(--color-soft); border: 1px solid transparent; border-radius: 8px; cursor: text; overflow-wrap: anywhere; transition: border-color .15s var(--ease-ui); }
.kp-desc:hover { border-color: var(--color-line2); }
.kp-desc-edit { display: flex; flex-direction: column; gap: 6px; }
.kp-row-end { display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
.kp-row-end > .kp-dim { margin-right: auto; }
.kp-row-wrap { display: flex; flex-wrap: wrap; gap: 8px; }
.kp-form { display: flex; flex-direction: column; gap: 12px; }
.kp-fields { display: flex; flex-direction: column; gap: 8px; }
.kp-field { display: grid; grid-template-columns: 6rem minmax(0, 1fr); align-items: center; gap: 8px; font-size: 12px; }
.kp-field-label { color: var(--color-dim); }
.kp-field input { height: 28px; font-size: 12px; }
.kp-path { display: flex; align-items: center; gap: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kp-actions { display: flex; flex-direction: column; gap: 6px; padding-top: 8px; border-top: 1px solid var(--color-line2); }
.kp-actions > button { justify-content: flex-start; }
.kp-log-box { display: flex; flex-direction: column; gap: 10px; padding-top: 8px; border-top: 1px solid var(--color-line2); }
.kp-thread { display: flex; flex-direction: column; gap: 10px; }
.kp-comments, .kp-log, .kp-sessions { display: flex; flex-direction: column; gap: 8px; margin: 0; padding: 0; list-style: none; }
.kp-comment { padding: 8px 10px; border-radius: 9px; background: color-mix(in srgb, var(--color-fg) 4%, transparent); font-size: 13px; }
.kp-comment-head { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; font-size: 12px; color: var(--color-muted); }
.kp-composer { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }
.kp-composer textarea { width: 100%; }
.kp-log-line { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--color-muted); }
.kp-log-line b, .kp-comment-head b { font-weight: 500; color: var(--color-soft); }
.kp-usage { display: flex; align-items: center; gap: 6px; margin: 0 0 6px; font-size: 12px; color: var(--color-muted); }
.kp-session { display: flex; width: 100%; align-items: center; gap: 8px; padding: 4px 8px; border-radius: 7px; font-size: 12px; text-align: left; color: var(--color-soft); transition: background-color .12s var(--ease-ui); }
.kp-session:hover { background: color-mix(in srgb, var(--color-fg) 6%, transparent); }
.kp-keys { display: grid; grid-template-columns: max-content 1fr; gap: 6px 14px; margin: 0; font-size: 13px; }
.kp-keys dd { margin: 0; color: var(--color-muted); }
.kp-keys kbd { padding: 1px 6px; border: 1px solid var(--color-line); border-radius: 5px; font-size: 11.5px; font-family: var(--font-mono, ui-monospace, monospace); }
.kp-enter { animation: kp-in .22s var(--ease-ui) both; }
.kp-fade { animation: kp-fade .18s var(--ease-ui) both; }
@keyframes kp-in { from { opacity: 0; transform: translateY(4px) scale(.98); } to { opacity: 1; transform: none; } }
@keyframes kp-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes kp-pulse { 50% { opacity: .35; } }
@media (max-width: 900px) { .kp-detail { grid-template-columns: 1fr; } .kp-side { width: 11rem; } }
@media (prefers-reduced-motion: reduce) { .kp-enter, .kp-fade, .kp-drop-line, .kp-working { animation: none; } .kp-tile, .kp-chip, .kp-chevron, .kp-side-item, .kp-side-icon { transition: none; } }
`;

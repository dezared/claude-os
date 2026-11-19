// The screen's own CSS: plugins get no Tailwind build. Colours are the app's --color-* tokens, so both themes follow.
export const CSS = `
.lrn-screen { position: relative; display: flex; min-height: 0; flex: 1; flex-direction: column; overflow-y: auto; color: var(--color-soft); }
.lrn-page { display: flex; flex-direction: column; gap: 14px; width: 100%; max-width: 980px; margin: 0 auto; padding: 22px 28px 40px; box-sizing: border-box; }
.lrn-lesson { max-width: 1100px; min-height: 100%; }
.lrn-view { animation: lrn-in 220ms var(--ease-ui); }
@keyframes lrn-in { from { opacity: 0; transform: translateY(6px); } }
.lrn-head { display: flex; align-items: center; gap: 10px; min-height: 32px; }
.lrn-title { flex: 1; min-width: 0; margin: 0; font-size: 20px; font-weight: 600; color: var(--color-fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lrn-head-tools { display: flex; align-items: center; gap: 8px; flex: none; }
.lrn-lead { margin: 0; color: var(--color-muted); font-size: 14px; line-height: 1.55; max-width: 720px; }
.lrn-section { margin: 8px 0 4px; font-size: 12px; font-weight: 600; letter-spacing: .05em; text-transform: uppercase; color: var(--color-dim); }
.lrn-empty { margin: 0; padding: 18px; border: 1px dashed var(--color-line); border-radius: 12px; color: var(--color-muted); font-size: 13px; }
.lrn-dim { color: var(--color-dim); font-size: 12px; margin: 0; }
.lrn-row, .lrn-row-end { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.lrn-row-end { justify-content: flex-end; }
.lrn-btn { display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 12px; border-radius: 8px; border: 1px solid var(--color-line); background: transparent; color: var(--color-soft); font: inherit; font-size: 12.5px; cursor: pointer; white-space: nowrap; }
.lrn-btn:hover:not(:disabled) { background: color-mix(in srgb, var(--color-fg) 7%, transparent); color: var(--color-fg); }
.lrn-btn:disabled { opacity: .5; cursor: default; }
.lrn-btn-primary { border-color: transparent; background: var(--color-accent); color: var(--color-on-accent); }
.lrn-btn-primary:hover:not(:disabled) { background: var(--color-accent-hover); color: var(--color-on-accent); }
.lrn-btn-danger { border-color: transparent; background: var(--color-bad); color: #fff; }
.lrn-icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; border-radius: 8px; border: 0; background: transparent; color: var(--color-muted); cursor: pointer; }
.lrn-icon-btn:hover { background: color-mix(in srgb, var(--color-fg) 8%, transparent); color: var(--color-fg); }
.lrn-chip { display: inline-flex; align-items: center; gap: 5px; height: 26px; padding: 0 10px; border-radius: 99px; border: 1px solid var(--color-line2); color: var(--color-muted); font-size: 12px; font-variant-numeric: tabular-nums; transition: color 200ms ease, border-color 200ms ease, background-color 200ms ease; }
.lrn-chip.is-hot { color: var(--color-accent); border-color: color-mix(in srgb, var(--color-accent) 45%, transparent); background: var(--color-accent-bg); }
.lrn-chip.is-ok { color: var(--color-ok); border-color: color-mix(in srgb, var(--color-ok) 40%, transparent); }
.lrn-bar { position: relative; height: 6px; border-radius: 99px; overflow: hidden; background: color-mix(in srgb, var(--color-fg) 9%, transparent); }
.lrn-bar-fill { position: absolute; inset: 0; transform-origin: left; background: linear-gradient(90deg, var(--color-accent-deep), var(--color-accent)); transition: transform 420ms var(--ease-ui); }
.lrn-progress { display: flex; align-items: center; gap: 12px; font-size: 12px; color: var(--color-muted); font-variant-numeric: tabular-nums; }
.lrn-progress .lrn-bar { flex: 1; max-width: 420px; }
.lrn-grid { position: relative; display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; }
.lrn-card { display: flex; flex-direction: column; gap: 10px; min-width: 0; padding: 16px; border-radius: 14px; border: 1px solid var(--color-line2); background: color-mix(in srgb, var(--color-card) 70%, transparent); color: inherit; font: inherit; text-align: left; cursor: pointer; transition: transform 240ms var(--ease-ui), border-color 160ms ease, background-color 160ms ease; @starting-style { opacity: 0; transform: translateY(6px); } }
.lrn-card:hover { border-color: var(--color-line); background: var(--color-card); }
.lrn-card-title { font-size: 15px; font-weight: 600; color: var(--color-fg); }
.lrn-card-goal { font-size: 12.5px; color: var(--color-muted); line-height: 1.5; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.lrn-card-foot { display: flex; justify-content: space-between; gap: 8px; font-size: 11.5px; color: var(--color-dim); }
.lrn-card-next { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lrn-new, .lrn-confirm, .lrn-offer { display: flex; flex-direction: column; gap: 10px; padding: 14px; border-radius: 12px; border: 1px solid var(--color-line2); background: color-mix(in srgb, var(--color-card) 75%, transparent); }
.lrn-confirm { flex-direction: row; align-items: center; justify-content: space-between; border-color: color-mix(in srgb, var(--color-bad) 40%, transparent); font-size: 13px; }
.lrn-label { font-size: 13px; color: var(--color-fg); }
.lrn-input { width: 100%; box-sizing: border-box; resize: vertical; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--color-line); background: var(--color-well); color: var(--color-fg); font: inherit; font-size: 13px; }
.lrn-input:focus { outline: 2px solid color-mix(in srgb, var(--color-accent) 50%, transparent); outline-offset: 0; }
.lrn-offers { display: flex; flex-direction: column; gap: 8px; animation: lrn-in 220ms var(--ease-ui); }
.lrn-offer { flex-direction: row; align-items: center; border-style: dashed; }
.lrn-offer-icon { flex: none; color: var(--color-accent); }
.lrn-offer-text { flex: 1; min-width: 0; font-size: 13px; }
.lrn-roadmap { position: relative; list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.lrn-node { position: relative; display: grid; grid-template-columns: 28px 1fr auto; gap: 12px; align-items: start; padding: 10px 0; }
.lrn-node::before { content: ''; position: absolute; left: 13px; top: 0; bottom: 0; width: 2px; background: var(--color-line2); }
.lrn-node:first-child::before { top: 20px; }
.lrn-node:last-child::before { bottom: calc(100% - 20px); }
.lrn-node.is-done::before { background: color-mix(in srgb, var(--color-ok) 45%, var(--color-line2)); }
.lrn-dot { position: relative; z-index: 1; display: flex; align-items: center; justify-content: center; width: 20px; height: 20px; margin: 0 4px; border-radius: 99px; border: 2px solid var(--color-line); background: var(--color-card); color: var(--color-card); transition: background-color 260ms ease, border-color 260ms ease, transform 260ms var(--ease-ui); }
.lrn-node.is-done .lrn-dot { background: var(--color-ok); border-color: var(--color-ok); }
.lrn-node.is-current .lrn-dot { border-color: var(--color-accent); box-shadow: 0 0 0 4px var(--color-accent-bg); animation: lrn-pulse 2.4s ease-in-out infinite; }
.lrn-node.is-skipped { opacity: .55; }
@keyframes lrn-pulse { 50% { box-shadow: 0 0 0 7px transparent; } }
.lrn-node-body { min-width: 0; }
.lrn-node-title { padding: 0; border: 0; background: none; color: var(--color-fg); font: inherit; font-size: 14px; font-weight: 500; text-align: left; cursor: pointer; }
.lrn-node-title:disabled { cursor: default; }
.lrn-node-title:hover:not(:disabled) { color: var(--color-accent); }
.lrn-node-summary { margin: 3px 0 0; font-size: 12.5px; color: var(--color-muted); line-height: 1.5; }
.lrn-node-meta { display: flex; gap: 8px; margin-top: 5px; font-size: 11px; color: var(--color-dim); }
.lrn-node.is-current .lrn-status { color: var(--color-accent); }
.lrn-node.is-done .lrn-status { color: var(--color-ok); }
.lrn-badge { padding: 0 6px; border-radius: 99px; background: color-mix(in srgb, var(--color-fg) 8%, transparent); }
.lrn-steps { position: relative; display: grid; grid-template-columns: repeat(3, 1fr); width: min(460px, 100%); padding: 3px; border-radius: 10px; background: color-mix(in srgb, var(--color-fg) 6%, transparent); }
.lrn-steps-thumb { position: absolute; top: 3px; bottom: 3px; left: 3px; width: calc((100% - 6px) / 3); border-radius: 8px; background: var(--color-card); box-shadow: 0 1px 3px rgba(0, 0, 0, .25); transform: translateX(calc(var(--at) * 100%)); transition: transform 260ms var(--ease-ui); }
.lrn-step { position: relative; display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 30px; border: 0; background: none; color: var(--color-muted); font: inherit; font-size: 12.5px; cursor: pointer; transition: color 160ms ease; }
.lrn-step[aria-selected='true'] { color: var(--color-fg); }
.lrn-count { min-width: 16px; padding: 0 4px; border-radius: 99px; background: var(--color-accent-bg); color: var(--color-accent); font-size: 10.5px; }
.lrn-panel { display: flex; flex-direction: column; gap: 14px; min-height: 0; }
.lrn-panel.is-article { flex: 1; }
.lrn-article { display: flex; flex: 1; flex-direction: column; gap: 10px; min-height: 0; }
.lrn-frame { width: 100%; height: max(480px, calc(100vh - 250px)); border-radius: 12px; background: var(--color-card); box-shadow: inset 0 0 0 1px var(--color-line2); }
.lrn-article-foot { display: flex; justify-content: flex-end; }
.lrn-quiz, .lrn-practice { display: flex; flex-direction: column; gap: 14px; max-width: 760px; }
.lrn-question { margin: 0; padding: 14px; border-radius: 12px; border: 1px solid var(--color-line2); display: flex; flex-direction: column; gap: 6px; }
.lrn-question legend { display: flex; gap: 8px; padding: 0 4px; color: var(--color-fg); font-size: 14px; font-weight: 500; }
.lrn-q-num { flex: none; width: 20px; height: 20px; border-radius: 99px; background: var(--color-accent-bg); color: var(--color-accent); font-size: 11px; display: inline-flex; align-items: center; justify-content: center; }
.lrn-option { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 8px; border: 1px solid transparent; cursor: pointer; font-size: 13px; transition: background-color 180ms ease, border-color 180ms ease, color 180ms ease; }
.lrn-option:hover { background: color-mix(in srgb, var(--color-fg) 5%, transparent); }
.lrn-option input { accent-color: var(--color-accent); margin: 0; }
.lrn-option.is-chosen { border-color: var(--color-line); }
.lrn-option.is-right { border-color: color-mix(in srgb, var(--color-ok) 55%, transparent); background: color-mix(in srgb, var(--color-ok) 12%, transparent); color: var(--color-fg); }
.lrn-option.is-wrong { border-color: color-mix(in srgb, var(--color-bad) 55%, transparent); background: color-mix(in srgb, var(--color-bad) 10%, transparent); }
.lrn-option-mark { margin-left: auto; color: var(--color-ok); }
.lrn-explain { margin: 4px 0 0; padding: 8px 10px; border-left: 2px solid var(--color-c-blue); color: var(--color-muted); font-size: 12.5px; line-height: 1.5; }
.lrn-result { display: flex; align-items: center; gap: 12px; padding: 12px 14px; border-radius: 12px; font-size: 13px; }
.lrn-result strong { font-size: 18px; color: var(--color-fg); font-variant-numeric: tabular-nums; }
.lrn-result span { flex: 1; }
.lrn-result.is-pass { background: color-mix(in srgb, var(--color-ok) 13%, transparent); border: 1px solid color-mix(in srgb, var(--color-ok) 40%, transparent); }
.lrn-result.is-fail { background: color-mix(in srgb, var(--color-warn) 12%, transparent); border: 1px solid color-mix(in srgb, var(--color-warn) 40%, transparent); }
.lrn-history h3, .lrn-videos h3, .lrn-grades h3 { margin: 6px 0; font-size: 12px; font-weight: 600; color: var(--color-dim); text-transform: uppercase; letter-spacing: .05em; }
.lrn-history ol { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; font-size: 12.5px; }
.lrn-history li { display: flex; justify-content: space-between; max-width: 320px; color: var(--color-muted); }
.lrn-history li.is-pass strong { color: var(--color-ok); }
.lrn-task { padding: 14px; border-radius: 12px; border: 1px solid var(--color-line2); background: color-mix(in srgb, var(--color-card) 75%, transparent); font-size: 13.5px; line-height: 1.6; white-space: pre-wrap; }
.lrn-task p { margin: 0 0 8px; }
.lrn-task summary { cursor: pointer; color: var(--color-accent); font-size: 12.5px; }
.lrn-videos { display: flex; flex-direction: column; gap: 6px; }
.lrn-video { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--color-line2); color: var(--color-soft); text-decoration: none; font-size: 13px; }
.lrn-video:hover { border-color: var(--color-line); color: var(--color-fg); }
.lrn-video svg { color: var(--color-bad); flex: none; }
.lrn-video .lrn-dim { margin-left: auto; }
.lrn-grades { display: flex; flex-direction: column; gap: 6px; }
.lrn-grade { display: flex; gap: 12px; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--color-line2); font-size: 13px; }
.lrn-grade strong { font-size: 16px; color: var(--color-warn); font-variant-numeric: tabular-nums; }
.lrn-grade.is-pass strong { color: var(--color-ok); }
.lrn-grade p { margin: 0; color: var(--color-muted); white-space: pre-wrap; }
.lrn-form { display: flex; flex-direction: column; gap: 12px; }
.lrn-form-row { display: grid; grid-template-columns: 1fr 200px; gap: 12px; }
.lrn-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.lrn-select { height: 34px; resize: none; }
.lrn-input-soft { color: var(--color-muted); }
.lrn-mono { font-family: ui-monospace, 'Cascadia Code', Menlo, Consolas, monospace; font-size: 12.5px; }
.lrn-edit-nodes { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.lrn-edit-node { display: grid; grid-template-columns: 24px 1fr 130px auto; gap: 8px; align-items: start; padding: 8px; border-radius: 10px; border: 1px solid var(--color-line2); background: var(--color-card); transition: transform 240ms var(--ease-ui), opacity 200ms ease; @starting-style { opacity: 0; transform: translateY(-4px); } }
.lrn-edit-num { padding-top: 8px; text-align: center; font-size: 12px; color: var(--color-dim); font-variant-numeric: tabular-nums; }
.lrn-edit-texts { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.lrn-edit-tools, .lrn-material-tools { display: flex; align-items: center; gap: 2px; }
.lrn-icon-btn:disabled { opacity: .35; cursor: default; }
.lrn-section-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 8px; }
.lrn-materials { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.lrn-material { padding: 8px 12px; border-radius: 10px; border: 1px solid var(--color-line2); transition: transform 240ms var(--ease-ui), opacity 200ms ease; @starting-style { opacity: 0; transform: translateY(4px); } }
.lrn-material-head { display: flex; align-items: center; gap: 8px; }
.lrn-material-head .lrn-node-title { flex: 1; min-width: 0; }
.lrn-material-head .lrn-badge { font-size: 11px; color: var(--color-dim); }
.lrn-material-text { margin: 8px 0 4px; padding: 12px 14px; max-height: 420px; overflow: auto; border-radius: 8px; background: var(--color-well); color: var(--color-soft); }
pre.lrn-material-text { white-space: pre-wrap; }
.lrn-frame-sm { height: 420px; margin-top: 8px; }
.lrn-exercise { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--color-line2); white-space: normal; }
.lrn-exercise code { padding: 1px 6px; border-radius: 5px; background: var(--color-well); color: var(--color-fg); }
.lrn-files { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 6px; }
.lrn-files li { display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px; border-radius: 6px; background: color-mix(in srgb, var(--color-fg) 6%, transparent); color: var(--color-muted); }
@media (prefers-reduced-motion: reduce) {
  .lrn-view, .lrn-offers, .lrn-node.is-current .lrn-dot { animation: none; }
  .lrn-bar-fill, .lrn-steps-thumb, .lrn-card, .lrn-dot, .lrn-edit-node, .lrn-material { transition: none; }
}
`;

// The window's start screens, data: pages of their own: a module apart so main.cjs stays readable.
// A screen with one message: the start failed. `retry` is the label of the link that starts again, or null.
const screenHtml = (title, detail, retry, BG) => `<!doctype html><meta charset="utf-8"><title>Claude OS</title>
<style>
html,body{height:100%;margin:0;background:${BG};color:#fafafa;font:13px/1.5 "Segoe UI",system-ui,sans-serif;-webkit-app-region:drag}
body{display:flex;align-items:center;justify-content:center}
main{max-width:640px;padding:32px}
i{display:block;width:8px;height:8px;border-radius:2px;background:#d97757;margin-bottom:14px;${retry ? '' : 'animation:p 1.1s ease-in-out infinite'}}
@keyframes p{50%{opacity:.25}}
pre{color:#a1a1aa;white-space:pre-wrap;font:12px/1.5 Consolas,monospace;margin:8px 0 16px;user-select:text}
a{color:#d97757;-webkit-app-region:no-drag}
</style><main><i></i><div>${title}</div><pre>${detail}</pre>${retry ? `<a href="claudeos://retry">${retry}</a>` : ''}</main>`;

// The start screen: each stage of the boot as it comes, the current one shimmering, and the time since the start.
const bootHtml = (t0, text, BG) => `<!doctype html><meta charset="utf-8"><title>Claude OS</title>
<style>
html,body{height:100%;margin:0;background:${BG};color:#fafafa;font:13px/1.5 "Segoe UI",system-ui,sans-serif;-webkit-app-region:drag}
body{display:flex;align-items:center;justify-content:center}
main{width:340px;padding:32px}
h1{font-size:15px;font-weight:600;margin:0 0 14px}
ol{list-style:none;margin:0;padding:0}
li{display:flex;align-items:center;gap:10px;height:24px;animation:in .25s cubic-bezier(.23,1,.32,1)}
li::before{content:"";flex:none;width:10px;height:10px;box-sizing:border-box;border-radius:50%;border:1.5px solid #3f3f46;border-top-color:#d97757;animation:spin .8s linear infinite}
li.done{color:#8b8b95}
li.done::before{content:"✓";border:0;animation:none;color:#5fb98a;font-size:11px;line-height:10px;text-align:center}
li.now span{background:linear-gradient(90deg,#b0b0b9 35%,#d97757 50%,#b0b0b9 65%) 0 0/300% 100%;-webkit-background-clip:text;background-clip:text;color:transparent;animation:sh 2s linear infinite}
p{color:#8b8b95;font-size:12px;margin:16px 0 0;font-variant-numeric:tabular-nums}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes sh{from{background-position:100% 0}to{background-position:-100% 0}}
@keyframes in{from{opacity:0;transform:translateY(4px)}}
@media (prefers-reduced-motion:reduce){li,li::before,li.now span{animation:none}li.now span{background:none;color:#fafafa}}
</style><main><h1>${text.starting}</h1><ol id="s"></ol><p id="t">${text.firstRun}</p></main>
<script>
const L=${JSON.stringify(text.stages)},s=document.getElementById('s'),t=document.getElementById('t'),t0=${t0},hint=t.textContent;
window.stage=(id)=>{for(const li of s.children)li.className='done';const li=document.createElement('li');li.className='now';li.innerHTML='<span></span>';li.firstChild.textContent=L[id]||id;s.appendChild(li)};
stage('wsl');
setInterval(()=>{const x=Math.floor((Date.now()-t0)/1000);t.textContent=hint+' '+Math.floor(x/60)+':'+String(x%60).padStart(2,'0')},1000);
</script>`;

module.exports = { bootHtml, screenHtml };

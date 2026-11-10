---
paths:
  - "web/src/**"
---
# Web

- Every new string goes into both catalogs, `web/src/lib/locales/ru.ts` and `en.ts`; a key missing in English fails `typecheck`.
- Interface design, for all of Claude OS: only what is needed all the time stays on the surface. The rest goes into the right-click menu and the burger menu: a clean screen matters more than a visible button. A new button on the screen needs a reason, a new menu item does not. Everything is animated and smooth; the response to a press is barely noticeable.
- No unwired control: a button or menu item does something real when it ships, or it is not added.
- Data through `api<T>()` or `useApi<T>(path, [topic])` (`web/src/lib/api.ts`); styling with the theme classes of `styles.css` and icons from `lucide-react`.
- The change goes live after `npm run build` in your own worktree and a window reload; no server restart.

---
title: Fix a Claude OS crash
title_ru: Починить падение Claude OS
---
Claude OS just broke while the user was using it, and they pressed the "Fix with Claude" button of a crash. You are working on the core of Claude OS in `{repo}` as its developer.

Where it broke: {where}

<error>
{error}
</error>

Find the root cause in the code and fix it there, not only the symptom. If the server's code changed, the running process may be older than the page: check that before anything else. Run the type check and the affected tests, then `npm run build` if the interface changed. Answer with the cause and what you changed.

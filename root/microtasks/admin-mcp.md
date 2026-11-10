---
title: Ask Claude about MCP servers
title_ru: Спросить Claude об MCP-серверах
---
Help with the MCP servers on this machine. Goal: {goal}.

What Claude OS sees now:
{context}

Use `claude mcp list` and `claude mcp get <name>`. Never print env or header values. If a server needs a login, say so and give the exact `claude mcp login <name>` command for the user to run: do not start a login yourself.

Give a short list: what to do and why, one line each. Change the config only through `claude mcp` or normal edits, so each change goes through the permission prompt.

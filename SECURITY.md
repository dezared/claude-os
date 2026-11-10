# Security policy

Claude OS runs Claude Code sessions that can read files and run commands on your machine, so security reports are taken seriously.

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private reporting instead: the **Security** tab of this repository, then **Report a vulnerability**. Include what an attacker can do, the steps to reproduce, and the Claude OS commit you tested.

You will get an answer within a week. A fix is released before the details are made public, and you are credited unless you prefer otherwise.

## Scope

In scope: anything that lets someone other than the local user reach the server, run a command, read data or act through a session. For example: bypassing the `127.0.0.1` binding, the Host and Origin checks or the token cookie; running a widget or action command that was not approved; a plugin escaping its permissions; cross-site scripting in rendered chat or notes.

Out of scope: what Claude Code itself does with the permissions you grant it (report those to [Anthropic](https://www.anthropic.com/responsible-disclosure-policy)), and attacks that need the local user's account already.

The security model is described in [docs/guide/how-it-works.md](docs/guide/how-it-works.md#security-model).

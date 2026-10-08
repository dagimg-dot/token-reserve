# token-reserve

A Claude Code mod that reserves the top of your plan's usage window for one session.

- `/reserve <percent> [five_hour|seven_day]` in the session to protect
- `/reserve` shows status, `/reserve off` releases

Other sessions stop at `100 - percent` of the window and tell you why.
Requires Claude Code / Desktop 2.1.286+ and a subscription plan.

```bash
claude --plugin-dir ./token-reserve
```

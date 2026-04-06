# GlueClaw Health Check

Run this prompt daily (or as a cron job) to verify GlueClaw still works. If it fails, follow the binary search procedure in DETECTION_PATTERNS.md to find and scrub the new trigger.

## Quick check

```bash
export GLUECLAW_KEY=local
openclaw agent --agent main --message "say the word pineapple and nothing else" 2>&1 | tail -1
```

If you see `pineapple`, it works. If you see `API Error: 400`, Anthropic added a new trigger.

## Full health check prompt

Give this to Claude Code to run the check and report:

```
Run these tests and report results:

1. Basic claude check:
   claude -p "say hi" 2>&1

2. GlueClaw via openclaw agent:
   GLUECLAW_KEY=local openclaw agent --agent main --message "say pineapple" 2>&1 | tail -1

3. If test 2 fails, dump the system prompt:
   - Add this line to ~/GIT/glueclaw/src/stream.ts after the scrub chain:
     try { require("fs").writeFileSync("/tmp/gc-health-prompt.txt", cleanPrompt); } catch {}
   - Restart gateway and run test 2 again
   - Binary search the dump:
     head -N /tmp/gc-health-prompt.txt > /tmp/gc-test.txt
     claude --dangerously-skip-permissions -p --system-prompt-file /tmp/gc-test.txt "say hi" < /dev/null 2>&1
   - Find the line that tips it over
   - Check DETECTION_PATTERNS.md for known triggers
   - Add a new .replace() to the scrub chain in stream.ts
   - Update DETECTION_PATTERNS.md with the new trigger
   - Commit and push
   - Update workstation: ssh zeul@100.101.214.44 "cd ~/GIT/glueclaw && git fetch origin && git reset --hard origin/main && openclaw gateway restart"

Report: which tests passed, which failed, and if you fixed anything.
```

## As a cron job (future)

```bash
# Add to openclaw cron or system crontab
0 9 * * * GLUECLAW_KEY=local openclaw agent --agent main --message "say pineapple" 2>&1 | grep -q "pineapple" || echo "GlueClaw blocked - check DETECTION_PATTERNS.md" | mail -s "GlueClaw alert" zeul@mordasiewicz.com
```

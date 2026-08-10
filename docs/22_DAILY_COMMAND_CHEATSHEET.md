# Daily Telegram Cheatsheet

No terminal is needed.

```text
/topics                 current recommendations
/refresh                next unused recommendations
/skip_cycle             skip all pending topics
/add <topic>            custom topic
/link <https://…>       custom source URL
/queue                  topic states
/drafts                 final article-review states
/review <topic_id>      reopen final review
/publications           publication states
/jobs                   automation queue and failures
/retry <job_id>         retry failed/blocked work
/cancel_job <job_id>    cancel queued work
/system_status          production readiness
/help                   all commands
```

Normal successful path: approve one topic, wait for the final article card, then approve the exact article. Everything between and after those gates is automatic.

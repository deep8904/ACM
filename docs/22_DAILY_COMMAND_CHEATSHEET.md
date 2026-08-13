# Daily Telegram Cheatsheet

No terminal is needed.

```text
/topics                 current recommendations
/refresh                next unused recommendations
/skip_cycle             skip all pending topics
/add <topic>            custom topic
/link <https://…>       custom source URL
/interests              view and manage editorial interests
/interest_add Name | keyword one, keyword two
/interest_enable <id>   enable a saved interest
/interest_disable <id>  disable without deleting history
/interest_remove <id>   remove from normal lists; preserve audit
/queue                  topic states
/drafts                 final article-review states
/review <topic_id>      reopen final review
/publications           publication states
/jobs                   actionable cards and research recovery
/jobs all               recent history and diagnostics
/retry <job_id>         retry failed/blocked work
/cancel_job <job_id>    cancel queued work
/system_status          readiness plus discovery window/timing
/help                   all commands
```

Normal successful path: approve one topic, wait for the final article card, then approve the exact article. Everything between and after those gates is automatic.

Discovery occurs Monday and Thursday at 16:00 UTC. Two offset hourly schedules give the worker a nominal twice-hourly wakeup; delayed wakeups reconcile missed durable work but cannot create additional scheduled discovery runs.

# Platform signals

Every problem the platform can detect in itself files (or updates) exactly
one request on Homeroom's own board, and closes it once the problem has
stopped. The Homeroom bot fixes the ones in this repository's code; the rest
wait for a person, with the diagnosis already written.

- Service: `src/services/platform-signals.js` (lifecycle, filing, closing)
- What counts as a problem: `src/services/platform-signal-observers.js`
- What a request says, and the scrubbing: `src/services/platform-signal-evidence.js`
- Alertmanager's webhook: `src/routes/alerts-webhook.js`
- Table: `platform_signals` (one row per episode), `platform_signal_sources`

## Switches

Set in the chart's `config.platformSignals` values
(`deploy/helm/social-vibecoding-platform/values.yaml`):

| Value | Env | Meaning |
| --- | --- | --- |
| `mode` | `PLATFORM_SIGNALS` | `shadow` (default): keep the rows the topic pages and figures read, file nothing. `file`: file requests. `off`: nothing. Staging is `off` unless set. |
| `kinds` | `PLATFORM_SIGNALS_KINDS` | Comma list of the kinds allowed to file; empty for all. |
| `bot` | `PLATFORM_SIGNALS_BOT` | `off` leaves every request to people. |
| `securityAudit` | `PLATFORM_SIGNALS_SECURITY_AUDIT` | Chart default `on`: file only `security` and `security_audit` while production is in shadow mode. Global off, staging and the kind allowlist still apply. |

Rollout: a week in `shadow`, checking that each kind's fingerprints are
stable (under 20 new a day) and that the week's incidents all have a row;
then `file`.

## Kinds (wave 1)

| Kind | Read from | Fixed by |
| --- | --- | --- |
| `checks_not_change` | `platform_incident` events | bot |
| `checks_platform_fault` | `chat_sessions.check_error_platform` | a person |
| `release_stalled` | `apps.release_stall` | bot (`workflow_failed`), else infra |
| `workflow` | `wf_instances` flags and deadlines, exhausted `wf_work` | bot |
| `bot_paused` | the `bot-lane` instance | a person |
| `limit` | `platform_limit_alerts` at `full` | a person |
| `project_deploys` | `apps.last_failure`, 3+ projects at one step in a day | bot |
| `alert` | Alertmanager (pushed) | infra; bot for Homeroom's own deployments |
| `alerting_silent` | no Watchdog heartbeat for 2 hours | infra |
| `security` | trusted daily Homeroom security-audit artifact | bot when a fix is published, otherwise a person |
| `security_audit` | failed, incomplete, missing or stale daily audit | a person |

Security requests are native Homeroom requests. The observer reuses this clock,
table, deduplication and bot queue; CI publishes data without issue-write or
production credentials. See [dependency regressions and security alerts](security/regression-gates-and-alerts.md).

## Connecting Alertmanager (infra repo)

1. Generate a random token. Put it in the platform's Secret as
   `ALERTMANAGER_WEBHOOK_TOKEN` (the `social-vibecoding` existing secret), and
   in the encrypted receiver file below. Until it is set the route answers 503.
2. In `prototype/bare-metal-platform/clusters/bare-metal-org/platform/values/alertmanager-discord.secrets.sops.yaml`,
   add a receiver beside `null` and `discord` (Helm replaces the whole list):

   ```yaml
   - name: homeroom
     webhook_configs:
       - url: http://social-vibecoding.social-platform.svc.cluster.local:3000/api/internal/alerts
         send_resolved: true
         max_alerts: 20
         http_config:
           authorization:
             type: Bearer
             credentials: <the token>
   ```

   Prometheus Operator v0.91.0 checks receivers against its own types, so add
   a case for this receiver to `scripts/tests/test_discord_alerts.py` before
   publishing, as the Discord receiver has.
3. In `kube-prometheus-stack.yaml`, add two routes as the FIRST children of
   the root route, both with `continue: true`, so the Discord allowlist below
   them is unchanged:

   ```yaml
   - receiver: homeroom
     continue: true
     matchers:
       - alertname = "Watchdog"
     repeat_interval: 1h
   - receiver: homeroom
     continue: true
     matchers:
       - severity =~ "critical|warning"
     group_by: ['alertname', 'namespace', 'deployment', 'persistentvolumeclaim', 'node', 'instance', 'mountpoint', 'database_cluster']
     group_wait: 1m
     group_interval: 5m
     repeat_interval: 1h
   ```

4. The platform's NetworkPolicy admits the `monitoring` namespace on port 3000
   (`networkPolicy.internalCallerNamespaces` in this repository's chart). If
   the cluster's own values override that list, add `monitoring` there too.

Every critical files a request; a warning files only when it is on
`FILING_WARNINGS` in `src/routes/alerts-webhook.js`, and is otherwise counted
on the infra topic page.

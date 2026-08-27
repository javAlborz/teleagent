# Hermes phone-agent trial rubric

Use this operator-owned rubric for the bounded Hermes trial. It records lived
call quality that the read-only evaluation dashboard cannot measure. It is not
an execution approval, production sign-off, or purchasing authorization.

## Privacy and safety rules

- Use only owner-controlled calls and keep the persistent voice panic locked.
- Do not test mutations, approvals, deployment, shell access, or third-party
  callers during this trial.
- Record no caller identifier, telephone number, transcript, prompt, response,
  provider credential, bearer token, or raw audio.
- Use an ordinal such as `trial-01`, not a call, session, or thread identifier.
- Keep free-text notes limited to behavior, for example `barge-in delayed` or
  `answer required repetition`; do not paraphrase conversation content.
- Treat dashboard token totals as usage accounting only. Any cost assessment
  must use a separately verified provider price and expected call frequency.

## Per-call record

Copy this block once for each owner-controlled call:

```text
Trial label: trial-__
UTC date: YYYY-MM-DD
Ended normally: yes / no / unknown

Audio clarity (1 unusable – 5 clear): __
Perceived response latency (1 unusable – 5 natural): __
Interruption and barge-in (1 unreliable – 5 predictable): __
Answer usefulness (1 unhelpful – 5 consistently useful): __
Privacy comfort (1 unacceptable – 5 comfortable): __

Behavior-only note, no conversation content:

Would repeat this call under the same constraints: yes / no / unsure
```

An interrupted, failed, or ambiguous call stays in the record. Do not rerun it
under the same label or turn an unknown outcome into a success by inference.

## Review after the minimum evidence window

Review only after the dashboard independently reports at least five terminal
sessions, activity on three UTC dates, at least fifteen accepted user turns,
at least 90% normal completion, and validated positive Realtime usage
accounting.

```text
Rubric completed for every trial call: yes / no
Voice latency acceptable over several calls: yes / no / unsure
Interruption and barge-in predictable: yes / no / unsure
Answers consistently useful for intended tasks: yes / no / unsure
Expected token cost affordable: yes / no / unknown
Privacy expectations met: yes / no / unsure

Observed Hermes host pressure acceptable: yes / no / unknown
Known defects to fix before another trial:

Operator conclusion: continue on Hermes / fix and repeat / stop evaluation
```

No rubric outcome authorizes buying a host. A dedicated-node pilot still needs
every machine gate, a completed rubric, and a separate explicit budget decision.

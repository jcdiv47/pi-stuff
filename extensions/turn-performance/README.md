# Pi turn performance

Shows provider-agnostic per-turn latency and throughput in Pi's existing footer via
`ctx.ui.setStatus()`. No provider request interception or custom footer is needed.

Example final status:

```text
TTFT 420ms · answer 2.10s · 38.4 tok/s · 812 tok (r 230)
```

- **TTFT** runs from `turn_start` to the first non-empty text, thinking, or tool-call
  delta. If a provider does not stream deltas, `≤` marks the completion time as an
  upper bound.
- **answer** appears when streamed thinking precedes the first answer-text token.
- **tok/s** uses Pi's final `usage.output` (which already includes reasoning tokens)
  over the observable generation interval.
- **eff ~tok/s** is used when reasoning tokens are reported but hidden from the stream;
  their true start time cannot be observed, so the rate uses the whole request duration.
- **r** is Pi's reported reasoning-token subset. If it is unavailable, visible thinking
  content is estimated.
- `~` marks token/rate estimates. The fallback is Pi's own general approximation:
  `ceil(characters / 4)`, which keeps local models with missing or zero-filled usage useful.

The completed turn remains in the footer until the next turn starts. During a turn, the
status updates every 250 ms without touching Pi's provider adapters or stream internals.

## OpenRouter sanity check

Run the repeatable two-trial benchmark with:

```sh
npm run benchmark:openrouter
```

It obtains the OpenRouter key through `pi auth print-api-key` inside the child process
and never prints it. The benchmark streams the same prompt through DeepSeek V4 Flash,
GPT OSS 120B, and GLM 5.3 Flash, then compares this extension's client-observed values
with `GET /api/v1/generation` metadata.

In the 2026-08-31 check, OpenRouter's output and reasoning counts matched this extension
on all nine requests. The comparable server/client rates differed by 5%, 10%, and 39%
in the final three-model pass. This is expected: the extension's ordinary `tok/s` starts
at the first observable generated delta, while OpenRouter's `generation_time` includes
additional upstream latency. Client TTFT likewise includes routing and network time that
is absent from OpenRouter's upstream latency measurement.

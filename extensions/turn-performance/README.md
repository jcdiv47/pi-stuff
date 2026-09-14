# Pi turn performance

Shows provider-agnostic per-turn latency and throughput in Pi's existing footer via
`ctx.ui.setStatus()`. The request hook observes timing only; it never rewrites the
payload, patches provider adapters, or replaces the footer.

Example final status:

```text
TTFT 420ms · answer 2.10s · 38.4 tok/s · 812 tok (r 230)
```

- **TTFT** runs from `before_provider_request` to the first non-empty text, thinking,
  or tool-call delta, using a monotonic clock. Custom providers without that hook fall
  back to `turn_start`. This excludes local turn preparation when the hook is available,
  but includes routing, network, queueing, and any unobservable reasoning latency.
  If a provider does not stream deltas, `≤` marks completion as an upper bound.
- **answer** appears when streamed thinking precedes the first answer-text token.
- **tok/s** uses `(usage.output - 1) / seconds(first delta → last delta)` with Pi's
  final usage (output already includes reasoning). Late usage-only chunks and stream
  teardown do not dilute decode speed. The `N - 1` convention excludes the first-token
  boundary, but a delta can contain multiple tokens: this is client-observed throughput,
  **not exact server decode TPS**. Single-chunk outputs and spans under 10 ms show `tok/s —`.
- **Live ~tok/s** excludes the entire first chunk from the characters-over-four
  numerator. Rates use the last delta's arrival time and do not decay while waiting for
  usage metadata. Initial single-chunk rates are omitted rather than inflated.
- **eff ~tok/s** is used when reasoning tokens are reported but hidden from the stream,
  or generation has no observable starting delta. It uses all output tokens over the
  whole request duration through message completion, not an invented decode interval.
- **r** is Pi's reported reasoning-token subset. If it is unavailable, visible thinking
  content is estimated.
- `~` marks token/rate estimates. Token totals fall back to `ceil(characters / 4)`;
  estimated decode rates use post-first-chunk characters divided by four. This keeps
  local models with missing, invalid, or zero-filled usage useful.
- Optional **Input/TTFT ~tok/s** divides `usage.input + usage.cacheWrite` by TTFT.
  Pi-normalized cache reads are excluded. This includes non-prefill latency (and possibly
  hidden reasoning), so it is **not server prefill throughput**; it is off by default.
- Aborted/error messages are marked; partial-output rates are not successful benchmarks.

The completed turn remains in the footer until the next turn, idle model change, or
session/tree change. Waiting timers stop on completion, abort, agent end, and shutdown.
UI refreshes are throttled to 250 ms; headless runs do not start a refresh timer.

## Display options

Toggle compact mode with `/turn-performance-compact`, or start Pi with
`--turn-performance-compact`. It keeps just TTFT and throughput, including uncertainty
and error markers:

```text
TTFT 420ms · 38.4 tok/s
```

Start with `--turn-performance-input-rate` to include the optional input-rate estimate
in the full display. Compact mode omits it. The command toggle is in-memory; `/reload`
restores the startup flag settings.

## Comparison with the Anemll gist

Reviewed [the gist](https://gist.github.com/Anemll/f95a14877862f289e19b12586850eded)
and its one comment (sivaxreddy, `6367110`). It is better at defining request/decode
boundaries, not a wholesale replacement for this extension.

Adopted:
- Provider-hook TTFT and first-to-last-delta decode timing, using final usage.
- The comment's first-chunk correction for live estimates and compact-display idea.
- Optional, explicitly approximate Input/TTFT.

Retained/improved here:
- Monotonic timing, thinking/tool deltas, answer latency, hidden-reasoning effective
  rates, non-streaming upper bounds, and missing-usage fallback.
- Timer cleanup and completed-result retention. The comment's unconditional
  `turn_end` reset would erase the result as soon as a text-only turn ends.
- Minimum-span guards and estimate markers. The gist's live 1 ms denominator can
  produce huge first-chunk rates; its final `N - 1` does not fully correct multi-token
  chunk buffering either. Neither implementation can recover server token timestamps
  or detect all hidden/buffered reasoning from Pi's events.

## Tests

```sh
npm test
npm run typecheck
```

Tests cover timing boundaries, late usage, first-chunk bias, hidden reasoning, tool
turns, invalid usage, buffered output, compact mode, and event/timer lifecycle cleanup.

## OpenRouter sanity check

Run the repeatable two-trial benchmark with:

```sh
npm run benchmark:openrouter
```

It obtains the OpenRouter key through `pi auth print-api-key` inside the child process
and never prints it. The benchmark streams the same prompt through DeepSeek V4 Flash,
GPT OSS 120B, and GLM 5.3 Flash, then compares this extension's client-observed values
with `GET /api/v1/generation` metadata.

In the historical 2026-08-31 check (before the first-to-last-delta timing change),
OpenRouter's output and reasoning counts matched this extension on all nine requests. The comparable server/client rates differed by 5%, 10%, and 39%
in the final three-model pass. This is expected: the extension's ordinary `tok/s` starts
at the first observable generated delta, while OpenRouter's `generation_time` includes
additional upstream latency. Client TTFT likewise includes routing and network time that
is absent from OpenRouter's upstream latency measurement. Those historical rate comparisons
do not validate the revised formula; rerun the benchmark for fresh measurements.

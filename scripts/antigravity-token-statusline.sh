#!/usr/bin/env bash
set -euo pipefail

LOG_DIR="${ANTIGRAVITY_TOKEN_LOG_DIR:-$HOME/.agy-usage}"
LOG_FILE="${ANTIGRAVITY_TOKEN_LOG_FILE:-$LOG_DIR/statusline-events.jsonl}"

mkdir -p "$LOG_DIR"
payload="$(cat)"

if [ -n "$payload" ]; then
  logged_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  if command -v jq >/dev/null 2>&1 && printf '%s' "$payload" | jq -e . >/dev/null 2>&1; then
    printf '%s' "$payload" | jq -c --arg logged_at "$logged_at" '{logged_at: $logged_at, payload: .}' >> "$LOG_FILE"
  else
    printf '%s\n' "$payload" >> "$LOG_FILE"
  fi
fi

if command -v jq >/dev/null 2>&1; then
  model="$(printf '%s' "$payload" | jq -r '.model.display_name // .model.id // .model // .active_model // .activeModel // .metadata.model // "Antigravity"' 2>/dev/null || printf 'Antigravity')"
  tokens="$(printf '%s' "$payload" | jq -r '
    (.token_usage // .usage // .usage_metadata // .usageMetadata // .context_window // .contextWindow // .payload.token_usage // .payload.usage // .payload.context_window // .payload.contextWindow // {}) as $u
    | if ($u.total_tokens // $u.totalTokens // $u.tokens_total // $u.tokensTotal // $u.total) != null then
        ($u.total_tokens // $u.totalTokens // $u.tokens_total // $u.tokensTotal // $u.total)
      elif ($u.total_input_tokens // $u.totalInputTokens) != null or ($u.total_output_tokens // $u.totalOutputTokens) != null then
        (($u.total_input_tokens // $u.totalInputTokens // 0) + ($u.total_output_tokens // $u.totalOutputTokens // 0))
      else
        (($u.prompt_tokens // $u.input_tokens // $u.inputTokens // $u.tokens_prompt // 0) +
         ($u.completion_tokens // $u.output_tokens // $u.outputTokens // $u.candidate_tokens // $u.tokens_completion // 0) +
         ($u.reasoning_tokens // $u.thinking_tokens // $u.thinkingTokens // $u.tokens_reasoning // 0) +
         ($u.cached_tokens // $u.cache_read_input_tokens // $u.cache_creation_input_tokens // $u.tokens_cached // 0))
      end
  ' 2>/dev/null || printf '0')"
  printf 'AGY %s tok - %s\n' "$tokens" "$model"
else
  printf 'AGY telemetry logging\n'
fi

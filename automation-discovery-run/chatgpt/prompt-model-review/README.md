# Prompt, model, and deprecation governance review

This tool audits McLellan Hub model and prompt governance without changing the Hub. It:

- inventories `SYSTEM_MODEL_GROUPS`, actual `getSystemModel*`/`getSystemPrompt` usages, `model_config`, and slot/prompt overrides;
- reports the exact admin destination for each slot (`/admin/models`, `/admin/models/system`, `/admin/models/prompts`, `/admin/models/tiers`);
- checks effective models against OpenRouter's live all-modality catalogue, including `expiration_date`, modalities, supported parameters, context, and price;
- ranks replacements only after hard capability filters;
- can add the best high-confidence replacement to a **copy** of a Hub database as `enabled=0`.

OpenRouter models are API identifiers, not local packages. “Install” therefore means adding a disabled `model_config` catalogue row. The tool never reassigns a live slot or edits a prompt.

## Review command

```bash
/Users/dm_mini/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 \
  prompt_model_review.py review \
  --repo '/Users/dm_mini/Documents/mclellan hub' \
  --hub-db '/Users/dm_mini/Documents/mclellan hub/data/hub.db' \
  --as-of 2026-07-18 \
  --save-catalog openrouter-catalogue.snapshot.json \
  --output review.json \
  --markdown review.md
```

Use `--catalog-json catalogue.json` for an offline, repeatable run. Use `--policy policy.json` to override inferred capability contracts for critical slots; `policy.example.json` shows the shape.

## Safe auto-install command

First copy the database into this write root. Then choose an issue ID from `review.json`:

```bash
/Users/dm_mini/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 \
  prompt_model_review.py auto-install \
  --report review.json \
  --issue 'slot:example:deprecated' \
  --target-db ./staging/hub.db \
  --write-root '/Users/dm_mini/Documents/mclellan hub/automation-discovery-run/chatgpt' \
  --output install-receipt.json
```

The command refuses to write outside the supplied write root, requires a score of at least `0.72` by default, inserts the candidate disabled, preserves all `hub_sys_model_*` and `hub_sys_prompt_*` rows, and is idempotent.

## OpenRouter routing note

For low-risk slots, a `~author/family-latest` alias can reduce version churn. Concrete model IDs remain preferable where reproducibility matters. `openrouter/auto` is useful for mixed prompts, but it is not a safe substitute for capability-specific slots such as embeddings, speech, vision, or governed structured-output jobs.

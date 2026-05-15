# Registering codex-responses-adapter with cc-switch

[cc-switch](https://github.com/farion1231/cc-switch) is a small helper
that lets you toggle between multiple Codex-compatible backends without
editing Codex CLI environment variables by hand. Because
`codex-responses-adapter` exposes the OpenAI Responses API at a stable
local URL, it can be added to cc-switch as a single Codex backend entry
and selected like any other provider.

This document shows the minimum configuration needed to wire them
together.

## Prerequisites

- The adapter is already running and reachable at
  `http://127.0.0.1:8787`. Verify with:

  ```bash
  curl http://127.0.0.1:8787/healthz
  # -> {"status":"ok"}
  ```

- You know the `admin_key` from your adapter
  `config.yaml`. That value doubles as the API key cc-switch hands to
  the Codex CLI.

- cc-switch is installed and has at least one existing Codex backend
  entry so you can see where new entries live.

## cc-switch backend entry

Add a new Codex backend entry whose base URL points at the adapter and
whose API key is the adapter's `admin_key`. The exact file path depends
on your cc-switch install, but the entry looks like this:

```toml
# Example cc-switch Codex backend entry
[[codex.backends]]
provider_label = "codex-responses-adapter"
base_url       = "http://127.0.0.1:8787/v1"
api_key        = "local-change-me"   # must match admin_key in adapter config.yaml
```

If your cc-switch install uses JSON or YAML instead of TOML, the field
names are the same:

```yaml
codex:
  backends:
    - provider_label: codex-responses-adapter
      base_url: http://127.0.0.1:8787/v1
      api_key: local-change-me
```

Key points:

- `base_url` **must end in `/v1`**. The adapter exposes the
  OpenAI-style routes (`/v1/responses`, `/v1/models`) under that prefix.
- `api_key` is the adapter's local `admin_key`, not your upstream
  provider key. The adapter translates that header into the real
  provider key server-side, so Codex never sees your DeepSeek/Qwen/GLM
  token.
- `provider_label` is free-form — anything recognisable in the
  cc-switch UI works.

## Switch and verify

After saving the entry, activate it in cc-switch and run the Codex CLI
as usual. cc-switch sets `OPENAI_BASE_URL` and `OPENAI_API_KEY` from
the selected entry, so no further Codex configuration is needed.

A quick smoke test (outside Codex) confirms the end-to-end path:

```bash
curl -H "Authorization: Bearer local-change-me" \
     http://127.0.0.1:8787/v1/models
```

The response is an OpenAI-style model list built from your
`model_mappings`.

## Troubleshooting

- **HTTP 401 / `invalid_api_key`** — the `api_key` in the cc-switch
  entry does not match the adapter's `admin_key`. Check both values
  and re-activate the entry.
- **Connection refused** — the adapter is not running on
  `127.0.0.1:8787`. Start it with
  `codex-responses-adapter start` and re-run the `/healthz` probe.
- **HTTP 404 / `model_not_found`** — the `model` Codex is sending
  isn't listed in `model_mappings`. Either add it as an alias or set a
  `default_model` in the adapter config.
- **Streaming hangs** — confirm the upstream provider's OpenAI-compatible
  endpoint supports `stream: true`; the adapter does not synthesize
  completion events when the upstream never emits a `finish_reason`.

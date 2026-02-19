# Ax-Fabric Phase 7 — Frontend Revamp Summary

## Overview

Phase 7 completes the frontend migration from Jan.ai to Ax-Fabric. This document summarises all UI changes made and any backend-facing contract requirements they introduce.

---

## 1. SetupScreen Revamp

**File:** `web-app/src/containers/SetupScreen.tsx`

**Before:** Jan-style onboarding that prompted users to download a local GGUF model via llamacpp.

**After:** Ax-Fabric onboarding that collects backend service URLs before entering the main UI.

### New Onboarding Flow

1. On first launch, `routes/index.tsx` checks `localStorage.getItem('setupCompleted')`. If absent (or no provider has an API key), `<SetupScreen />` is rendered.
2. SetupScreen presents four URL inputs:
   - **API Service** — OpenAI-compatible model inference endpoint (default `http://127.0.0.1:8000`)
   - **Retrieval Service** — document parsing, embedding, semantic search (default `http://127.0.0.1:8001`)
   - **Agents Service** — AI agent orchestration (default `http://127.0.0.1:8002`)
   - **AkiDB** — vector database REST API (default `http://127.0.0.1:8003`)
3. "Get Started" saves URLs via `useAxFabricConfig.setConfig()` and sets `localStorage.setupCompleted = 'true'`.
4. "Skip for now" skips URL entry and sets `localStorage.setupCompleted = 'true'`.

### hasValidProviders Logic (routes/index.tsx)

```typescript
const hasValidProviders =
  localStorage.getItem(localStorageKey.setupCompleted) === 'true' ||
  providers.some((provider) => Boolean(provider.api_key?.length))
```

---

## 2. Hub Page Fixes

**Files:** `web-app/src/routes/hub/index.tsx`, `web-app/src/routes/hub/$modelId.tsx`

- Removed MLX sort options; only `newest` and `most-downloaded` remain.
- Removed llamacpp/MLX "downloaded" provider check — `isDownloaded = false` for all variants (downloads are tracked via the download store only).
- `handleUseModel` now navigates with `provider: 'ax-fabric'` instead of `provider: 'llamacpp'`.
- `ModelDownloadAction.tsx` updated similarly: provider set to `'ax-fabric'`, `isDownloaded = false`.

---

## 3. Local API Server Settings Revamp

**File:** `web-app/src/routes/settings/local-api-server.tsx`

- Removed the entire Claude Code helper card section (including `useClaudeCodeModel` hook, `AddEditCustomCliDialog`, `HelperModelSelector`).
- Added **Ax-Fabric Backend Services** card with four URL inputs (API Service, Retrieval Service, Agents Service, AkiDB) backed by `useAxFabricConfig` store.
- Save button calls `useAxFabricConfig.setConfig()` which persists to localStorage and syncs to the Tauri backend via the `update_ax_fabric_service_config` command.

---

## 4. Provider Settings Cleanup

**File:** `web-app/src/routes/settings/providers/$providerName.tsx`

- Removed `useLlamacppDevices`, `useBackendUpdater`, `ImportVisionModelDialog`, `ImportMlxModelDialog` imports (all referenced deleted/non-existent modules).
- Removed the llamacpp/mlx backend installation UI (version_backend update buttons, Install from File button).
- Removed the llamacpp/mlx model Start/Stop buttons — API providers do not require explicit model lifecycle management.
- Removed the `flex-col-reverse` layout hack for llamacpp/mlx providers.
- Refresh models + Add model buttons are now shown for all providers uniformly.

**File:** `web-app/src/routes/settings/providers/index.tsx`

- Removed the special `stopAllModels()` call in the provider active toggle — it was only needed for llamacpp.

---

## 5. Hardware Settings Cleanup

**File:** `web-app/src/routes/settings/hardware.tsx`

- Removed `useLlamacppDevices` import (hook does not exist).
- Removed the GPU/llamacpp devices card (no local GPU management in Ax-Fabric).

**File:** `web-app/src/routes/system-monitor.tsx`

- Removed `useLlamacppDevices` import.
- Removed the Active GPUs card — system monitor now shows CPU and RAM only.

---

## 6. Root Layout Cleanup

**File:** `web-app/src/routes/__root.tsx`

- Removed `useJanModelPrompt` and `PromptJanModel` — the Jan model prompt banner is no longer shown.

---

## 7. Service and Utility Fixes

**`web-app/src/services/threads/default.ts`**

- Default engine fallback changed from `'llamacpp'` → `'ax-fabric'`.
- Default assistant `id` changed from `'jan'` → `'ax-fabric'`.

**`web-app/src/lib/ai-model.ts`**

- Removed the llamacpp placeholder configuration block.
- `createLanguageModel()` now uses a single code path for all providers (OpenAI-compatible).

**`web-app/src/lib/utils.ts`**

- Removed `llamacpp` and `mlx` cases from `getProviderLogo()` and `getProviderTitle()`.

**`web-app/src/containers/dialogs/AddEditCustomCliDialog.tsx`**

- Removed broken `import type { EnvVar } from '@/hooks/useClaudeCodeModel'`; `EnvVar` type now defined inline.

---

## 8. Backend Requirements for Phase 7 UI

The Phase 7 UI changes do not introduce new API endpoints beyond what was documented in `AX_FABRIC_BACKEND_SERVICES_CONTRACT.md` (Phase 6). However, the following are required for the new flows to work:

### 8.1 API Service — `/v1/models`
Used by the Hub page to list available models and by `DropdownModelProvider` to populate the model picker.

```
GET /v1/models
Response: { "object": "list", "data": [{ "id": "...", "object": "model" }] }
```

### 8.2 API Service — OpenAI Chat Completions
The main chat flow uses the standard OpenAI-compatible endpoint:

```
POST /v1/chat/completions
Content-Type: application/json
Authorization: Bearer <api_key>  (if configured)

{
  "model": "model-id",
  "messages": [...],
  "stream": true
}
```

### 8.3 Retrieval Service (unchanged from Phase 6)
See `AX_FABRIC_BACKEND_SERVICES_CONTRACT.md` for full retrieval/ingest API contract.

### 8.4 Agents Service (unchanged from Phase 6)
See `AX_FABRIC_BACKEND_SERVICES_CONTRACT.md` for full agents API contract.

### 8.5 CORS Requirements
All services must return:
```
Access-Control-Allow-Origin: *  (or tauri://localhost for desktop)
Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS
Access-Control-Allow-Headers: Content-Type, Authorization
```

---

## 9. localStorage Keys Used by Frontend

| Key | Purpose |
|-----|---------|
| `setupCompleted` | `'true'` after onboarding is finished or skipped |
| `ax-fabric-service-config` | Zustand persist store for 4 backend service URLs |

Format of `ax-fabric-service-config`:
```json
{
  "state": {
    "config": {
      "apiServiceUrl": "http://127.0.0.1:8000",
      "retrievalServiceUrl": "http://127.0.0.1:8001",
      "agentsServiceUrl": "http://127.0.0.1:8002",
      "akidbUrl": "http://127.0.0.1:8003"
    }
  },
  "version": 0
}
```

---

## 10. Files Still Containing Dead Code (non-breaking)

The following files contain references to old Jan/llamacpp logic but are either no longer rendered or the references are in comments/test files and will not cause compile errors:

- `web-app/src/containers/PromptJanModel.tsx` — still exists but no longer imported anywhere
- `web-app/src/hooks/useJanModelPrompt.ts` — still exists but no longer used
- `web-app/src/constants/models.ts` — contains `NEW_JAN_MODEL_HF_REPO`, `SETUP_SCREEN_QUANTIZATIONS` (only used by `PromptJanModel.tsx`)
- `web-app/src/containers/DropdownModelProvider.tsx` — has llamacpp references in dead conditional branches
- `web-app/src/containers/ChatInput.tsx` — has llamacpp references in dead conditional branches
- `web-app/src/hooks/useModelProvider.ts` — contains llamacpp migration code

These are safe to leave for now; they do not affect the build or runtime behaviour.

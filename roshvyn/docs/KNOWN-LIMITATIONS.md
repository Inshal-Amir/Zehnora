# Known limitations (honest list)

## Not yet possible / not yet tested
- **No GPU run yet.** vLLM, the real model, the server Compose stack, nginx and the tunnel are written and validated only on paper (`docker compose config`, `bash -n`). Gates B, C, E and parts of F are open.
- **Windows not tested.** `Preflight.ps1`, `Start-Desktop.ps1`, PowerShell/CMD execution and Windows path/junction handling in the connector have not run on Windows.
- **Google connector not connected** (needs the owner's OAuth client). No Gmail/Drive/Calendar/Docs/Sheets action has been verified.
- **Domain/tunnel** not configured (placeholder `<OWNER_DOMAIN>`).
- **Private GitHub repository** not created yet; `origin` is not set. Commits exist only locally on branch `feat/platform`.
- **Docker Desktop on the Mac crashes at startup** (existing problem, logged since 2026-09-18). The Mac uses native processes; server images have not been built here.
- **Document upload / RAG** (brief 7.6) not configured yet: LibreChat's file search needs its RAG API and an embeddings model.
- **ABC full-stack demonstration** (Gate E) not run: it needs the GPU model; the Mac 4B stand-in is too slow and too small to count.

## Design limits (by choice or upstream)
- **Partial stream billing:** LiteLLM 1.102.0 turns a truncated upstream stream into a normal-looking ending with a tokenizer-counted usage chunk; partial generations are charged that gateway-reported delivered usage.
- **Input-token reservation is an upper bound** (UTF-8 bytes + template overhead), so small requests reserve more than they finally cost (the difference is released at settlement).
- **No per-action approval in LibreChat v0.8.7.** Sending email, sharing and invitations are disabled in the Google connector; general shell commands go through Roshvyn's own approval window instead.
- **The workspace connector is not a sandbox.** Allowlisted build/test commands and scripts the model writes run with the user's permissions inside the chosen folder. Approval protects other programs, not the content of scripts the model wrote.
- **Google tokens** are stored as JSON files in a user-only folder, not in the OS keychain.
- **Separate accounts:** platform (portal) and Desktop (LibreChat) logins are separate; no shared login or chat sync.
- **Password reset/email verification** returns 503 until an email provider is configured.
- **One consumer GPU** is a controlled demo deployment, not a multi-user capacity promise. `--max-num-seqs 1` at the start; the platform answers 429 beyond its in-flight limit.
- **Unattended boot** is not supported: Docker Desktop needs a Windows login before `start.sh`.
- Responses pass through LiteLLM's `system_fingerprint`/`provider_specific_fields` fields.

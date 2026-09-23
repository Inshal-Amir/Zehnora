# Google Workspace connector setup

**Status: BLOCKED on owner credentials.** The connector is installed and its tool selection is verified; no Google account has been connected, and no Gmail/Drive/Calendar/Docs/Sheets action has been tested yet.

## Connector choice
- Candidate inspected: `taylorwilsdon/google_workspace_mcp` (community connector, **not** an official Google server). MIT license, actively maintained (last push 2026-09-21), GitHub release **v1.27.1** = PyPI `workspace-mcp==1.27.1` (pinned in `zehnora/connectors/google/uv.lock`).
- Transport used: **stdio, `--single-user`**. One connector process per desktop user, launched by that user's LibreChat, so credentials are not shared between unrelated LibreChat users.
- Tool selection (verified by listing tools with the pinned build): tier `extended` for gmail, drive, calendar, docs, sheets, minus 33 disabled tools, leaving **19**: `search_gmail_messages, get_gmail_message_content, draft_gmail_message, search_drive_files, get_drive_file_content, list_drive_items, create_drive_folder, create_drive_file, update_drive_file, list_calendars, get_events, manage_event, get_doc_content, create_doc, modify_doc_text, list_spreadsheets, read_sheet_values, modify_sheet_values, create_spreadsheet`.
- **Disabled on purpose:** `send_gmail_message`, sharing and permission tools, filters/labels. LibreChat v0.8.7 has no per-action approval step, so sends/invitations/sharing cannot be tied to an exact approval. The agent creates **drafts**; you send them from Gmail. A demo send can be added later with a real approval flow.
- `manage_event` can also delete events; the Desktop agent instructions forbid deletion, but that is prompt-level only. Use a dedicated demo calendar.

## Owner steps (Google Cloud console)
1. Create a Google Cloud project (e.g. "Zehnora Desktop Demo").
2. APIs & Services → Library → enable: **Gmail API, Google Drive API, Google Calendar API, Google Docs API, Google Sheets API**.
3. OAuth consent screen: User type **External**, publishing status **Testing**, add yourself and the demo account as **test users**. Testing mode limits access to listed test users, and refresh tokens for testing-mode apps can expire after about 7 days (reconnect when that happens). Restricted scopes (Gmail) may need Google verification before any public release; this demo does not claim arbitrary public users can connect Gmail.
4. Credentials → Create credentials → OAuth client ID. The connector's stdio flow redirects to `http://localhost:8765/oauth2callback` (`WORKSPACE_MCP_PORT=8765`). **Verify the correct client type against the connector's docs for v1.27.1 before creating it**: Desktop-app and Web-app clients are not interchangeable. For a Web application client, add the exact redirect URI `http://localhost:8765/oauth2callback`.
5. Download the client JSON and save it as `.local-dev/client/secrets/google-client-secret.json` (Mac development) with `chmod 600`. Never commit it, paste it into chat, or put it in a prompt.
6. Restart Desktop (`zehnora/scripts/mac/start-desktop.sh`); the launcher logs "Google Workspace connector enabled".
7. In Zehnora Desktop, ask the Google agent to list your calendars. The connector returns a Google sign-in link; open it in your normal browser and consent. The model never sees your Google password.

Tokens are stored in `.local-dev/client/secrets/google-credentials/` (user-only folder). They are plain JSON files protected by filesystem permissions, not the OS keychain: a known limitation.

## Required demonstrations (after connecting): record real IDs and contents
| Service | Read test | Write test |
|---|---|---|
| Gmail | Find/read a designated test message | Create a **draft** (sending is disabled) |
| Calendar | List events in a demo calendar/time range | Create then update a demo event (no attendees); check timezone and event ID |
| Drive | List/search a demo folder | Create a demo folder; move/rename a test file (`update_drive_file`); no sharing |
| Docs | Read a designated document | Create a document and append a paragraph; read it back |
| Sheets | Read a designated range | Create/update a demo range; read the cells back |

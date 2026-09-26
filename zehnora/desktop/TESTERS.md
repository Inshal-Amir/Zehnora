# Zehnora Desktop – tester guide

Thank you for testing Zehnora. The app talks to the Zehnora model running on our own GPU server.

## Install

| Computer | File |
|---|---|
| Windows 10/11 | `Zehnora-Setup-0.2.0.exe` |
| Mac with Apple Silicon (M1–M4) | `Zehnora-0.2.0-mac-arm64.dmg` |
| Mac with Intel | `Zehnora-0.2.0-mac-x64.dmg` |

The app is not yet signed by Apple/Microsoft, so the system warns once:
- **Windows:** "Windows protected your PC" → **More info** → **Run anyway**.
- **Mac:** open the dmg, drag Zehnora into Applications. The first time, **right-click Zehnora → Open → Open**. If macOS says the app "is damaged", run this once in Terminal: `xattr -cr /Applications/Zehnora.app`

## Start

1. Open Zehnora and choose **Create account** (email + a password of at least 10 characters). The app connects itself; no key to copy.
2. **Chat** (left switch): normal questions, web search, GitHub search.
3. **Work**: Zehnora does tasks on your computer, e.g. "Create a React app called todo-app and run it", "Set up PostgreSQL in Docker", "Check which developer tools I have". Work tasks use your default folder `~/Zehnora` (change it with the folder button at the top right).

Risky actions (deleting, `git push`, `sudo`, installing system software, changes outside the working folder) always show **Allow / Deny** first. Deleted files go to the Trash / Recycle Bin.

## Please tell us

- What you asked, and whether the answer or result was right.
- Anything that failed: the red error text, or a screenshot.
- Speed: how long answers took.
- Your computer: Windows or Mac, and which model.

Known limits: one shared GPU, so answers can be slow when several people use it; if you see "The Zehnora server is offline", try again later.

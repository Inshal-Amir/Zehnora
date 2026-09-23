"""List the tools the pinned Google Workspace MCP exposes with Zehnora's selection (no Google login needed)."""
import asyncio, os, sys, json
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
ARGS = sys.argv[1:] or ["--tools", "gmail", "drive", "calendar", "docs", "sheets", "--tool-tier", "core"]
async def main():
    env = dict(os.environ, GOOGLE_OAUTH_CLIENT_ID="listing-only.apps.googleusercontent.com", GOOGLE_OAUTH_CLIENT_SECRET="listing-only",
               WORKSPACE_MCP_CREDENTIALS_DIR=os.path.expanduser("~/.zehnora/google-credentials-listing"))
    p = StdioServerParameters(command=os.path.join(os.path.dirname(sys.executable), "workspace-mcp"), args=["--single-user", *ARGS], env=env)
    async with stdio_client(p) as (r, w), ClientSession(r, w) as s:
        await s.initialize()
        tools = (await s.list_tools()).tools
        print(len(tools), "tools")
        for t in tools:
            print(" -", t.name)
asyncio.run(main())

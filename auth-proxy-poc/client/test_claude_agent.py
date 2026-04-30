"""Claude Agent SDK live test through the auth-proxy.

The SDK's underlying Claude Code CLI hits api.anthropic.com, which the test
stack's TLS-terminator + DNS aliases redirect into the auth-proxy. The proxy
strips the placeholder x-api-key and injects the real one server-side.
"""
import asyncio
import os
import sys

# The SDK / CLI both refuse to start without ANTHROPIC_API_KEY. The proxy
# strips and replaces it; any non-empty value works.
if not os.environ.get("ANTHROPIC_API_KEY"):
    os.environ["ANTHROPIC_API_KEY"] = "placeholder-stripped-by-proxy"

from claude_agent_sdk import query, ClaudeAgentOptions  # noqa: E402


async def main() -> None:
    print("[claude-agent-sdk] running query() through tls-front -> auth-proxy...")

    options = ClaudeAgentOptions(
        model="claude-haiku-4-5-20251001",
        max_turns=1,
    )

    captured: list[object] = []
    async for msg in query(
        prompt="Reply with the single word: validated",
        options=options,
    ):
        captured.append(msg)
        # Print a short summary of every message we get back.
        text = repr(msg)
        if len(text) > 200:
            text = text[:200] + "..."
        print(f"  {type(msg).__name__}: {text}")

    if not captured:
        print("FAIL: no messages received")
        sys.exit(1)

    blob = " ".join(repr(m) for m in captured).lower()
    if "validated" not in blob:
        print("FAIL: 'validated' not found in any message — proxy or routing broken")
        sys.exit(1)

    print(f"[claude-agent-sdk] PASS — {len(captured)} messages, response contained 'validated'")


asyncio.run(main())

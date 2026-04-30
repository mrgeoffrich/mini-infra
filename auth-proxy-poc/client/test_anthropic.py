import os
import sys

from anthropic import Anthropic

# In MITM mode the SDK's default base_url (api.anthropic.com) is DNS-routed
# to the tls-front sidecar, so we don't override base_url. The proxy strips
# any inbound x-api-key and replaces it with the real one — but the SDK
# refuses to construct without an api_key, so we pass a placeholder.
api_key = os.environ.get("ANTHROPIC_API_KEY") or "placeholder-stripped-by-proxy"

client = Anthropic(api_key=api_key)

print("[anthropic] non-streaming...")
msg = client.messages.create(
    model="claude-haiku-4-5-20251001",
    max_tokens=64,
    messages=[{"role": "user", "content": "Reply with the single word: validated"}],
)
text = msg.content[0].text.strip()
print(f"  response: {text!r}")
print(f"  tokens: in={msg.usage.input_tokens} out={msg.usage.output_tokens}")
if "validated" not in text.lower():
    print("FAIL")
    sys.exit(1)

print("[anthropic] streaming...")
chunks = 0
with client.messages.stream(
    model="claude-haiku-4-5-20251001",
    max_tokens=64,
    messages=[{"role": "user", "content": "Count from 1 to 5, one number per line."}],
) as stream:
    for piece in stream.text_stream:
        sys.stdout.write(piece)
        sys.stdout.flush()
        chunks += 1
print()
if chunks < 2:
    print(f"FAIL: streaming produced {chunks} chunks (expected multiple)")
    sys.exit(1)

print(f"[anthropic] PASS — non-streaming + {chunks} streamed chunks")

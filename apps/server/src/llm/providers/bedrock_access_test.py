import os
 
import truststore
 
truststore.inject_into_ssl()  # trust Windows' OS certificate store (needed behind corporate TLS-inspecting proxies)
 
import boto3

# Set AWS_BEARER_TOKEN_BEDROCK in your shell environment before running this script
# (AWS Console: Amazon Bedrock -> API keys -> Generate API key). Never hardcode it
# here — this file is tracked in git and a live key would end up in history.
if "AWS_BEARER_TOKEN_BEDROCK" not in os.environ:
    raise SystemExit("Set AWS_BEARER_TOKEN_BEDROCK in your environment before running this script.")

REGION = "us-east-1"
# Newer Claude models require an inference profile ID (region-prefixed), not the bare model ID
MODEL_ID = "us.anthropic.claude-sonnet-4-5-20250929-v1:0"
 
client = boto3.client("bedrock-runtime", region_name=REGION)
 
response = client.converse(
    modelId=MODEL_ID,
    messages=[{"role": "user", "content": [{"text": "Hi"}]}],
)
 
print(response["output"]["message"]["content"][0]["text"])
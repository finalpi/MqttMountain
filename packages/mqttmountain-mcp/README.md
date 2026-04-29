# mqttmountain-mcp

MCP server for reading MQTTMountain message logs from AI clients.

## Usage

After publishing this package to npm:

```json
{
  "mcpServers": {
    "mqttmountain": {
      "command": "npx",
      "args": ["-y", "mqttmountain-mcp"]
    }
  }
}
```

If MQTTMountain uses a custom log directory, pass it explicitly:

```json
{
  "mcpServers": {
    "mqttmountain": {
      "command": "npx",
      "args": [
        "-y",
        "mqttmountain-mcp",
        "--log-dir",
        "C:/Users/you/AppData/Roaming/MQTTMountain/message_logs"
      ]
    }
  }
}
```

## Tools

- `mqttmountain_connections`: List saved MQTTMountain connections and log folders.
- `mqttmountain_recent_messages`: Read recent messages for one connection. Accepts `connectionId` or `connectionName`, plus optional exact `topic`.
- `mqttmountain_message_status`: Read a compact recent-message summary in one call. Accepts `connectionId`, `connectionName`, or fuzzy `connectionKeyword`, plus optional `topic`, `topicKeyword`, `keyword`, and `minutes`.
- `mqttmountain_payload_samples`: Read compact latest payload samples. Returns JSON keys, common fields, byte length, and short previews by default.
- `mqttmountain_query_history`: Query persisted messages by connection, topic, keyword, and time range. Accepts `connectionId` or `connectionName`.

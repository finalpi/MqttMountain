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
- `mqttmountain_recent_messages`: Read recent messages for one connection.
- `mqttmountain_query_history`: Query persisted messages by connection, topic, keyword, and time range.

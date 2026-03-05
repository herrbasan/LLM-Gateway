# WebAdmin API Specification

## Base URL
All endpoints are prefixed with `/api`

Example: `http://localhost:3401/api/health`

---

## Endpoints

### Health Check
Get gateway health status.

```
GET /api/health
```

**Response:**
```json
{
  "status": "healthy",
  "timestamp": "2026-03-03T12:00:00Z",
  "version": "1.0.0"
}
```

---

### Tasks
Get active and queued tasks.

```
GET /api/tasks
```

**Response:**
```json
{
  "active": [
    {
      "id": "abc-123",
      "provider": "lmstudio",
      "model": "qwen3-coder-30b",
      "status": "running",
      "startTime": "2026-03-03T11:58:00Z",
      "elapsedSeconds": 120
    }
  ],
  "queue": {
    "pending": 5,
    "completed": 42,
    "failed": 1
  }
}
```

---

### Models
Get available models from all providers.

```
GET /api/models
```

**Response:**
```json
{
  "providers": {
    "lmstudio": {
      "status": "online",
      "models": [
        { "id": "qwen3-coder-30b", "name": "Qwen3 Coder 30B" }
      ]
    },
    "gemini": {
      "status": "online",
      "models": [
        { "id": "gemini-flash-latest", "name": "Gemini Flash" }
      ]
    }
  }
}
```

---

### Get Config
Get current gateway configuration.

```
GET /api/config
```

**Response:**
```json
{
  "port": 3400,
  "host": "0.0.0.0",
  "providers": { ... },
  "routing": { ... }
}
```

**Error Responses:**
- `500`: Failed to read config file

---

### Update Config
Update gateway configuration.

```
POST /api/config
```

**Request Body:**
```json
{
  "port": 3400,
  "host": "0.0.0.0",
  "providers": { ... }
}
```

**Response:**
```json
{
  "success": true,
  "message": "Configuration saved successfully",
  "backup": "config.backup.20260303-120000.json"
}
```

**Error Responses:**
- `400`: Invalid JSON
- `400`: Validation failed (with details)
- `500`: Failed to write config file

**Validation Rules:**
- `port`: Number, 1-65535
- `host`: String, valid IP or hostname
- `providers`: Object, must have at least one provider
- Provider must have `type` and required fields for that type

---

### Get Logs
Get recent errors and warnings.

```
GET /api/logs?limit=50&level=error
```

**Query Parameters:**
- `limit` (optional): Number of entries, default 50, max 1000
- `level` (optional): Filter by level - `error`, `warn`, `info`, `all`

**Response:**
```json
{
  "entries": [
    {
      "timestamp": "2026-03-03T11:55:00Z",
      "level": "error",
      "message": "Provider lmstudio connection timeout",
      "source": "router"
    }
  ],
  "total": 1
}
```

---

### Proxy to Gateway
Proxy any request to the LLM Gateway.

```
POST /api/proxy/{gateway-path}
GET /api/proxy/{gateway-path}
```

**Examples:**
- `POST /api/proxy/chat/completions` → Proxies to Gateway `/chat/completions`
- `GET /api/proxy/models` → Proxies to Gateway `/models`

**Request/Response:**
Passes through exactly as received from gateway.

---

### Sessions

#### List Sessions
```
GET /api/proxy/sessions
```

**Response:**
```json
{
  "sessions": [
    {
      "id": "sess-123",
      "created": "2026-03-03T10:00:00Z",
      "lastUsed": "2026-03-03T11:00:00Z",
      "messageCount": 15
    }
  ]
}
```

#### Create Session
```
POST /api/proxy/sessions
```

**Response:**
```json
{
  "sessionId": "sess-456",
  "created": "2026-03-03T12:00:00Z"
}
```

#### Delete Session
```
DELETE /api/proxy/sessions/{id}
```

**Response:**
```json
{
  "success": true
}
```

---

## Error Response Format

All errors follow this format:

```json
{
  "error": true,
  "message": "Human readable error message",
  "code": "ERROR_CODE",
  "details": { ... }  // Optional additional info
}
```

**Common Error Codes:**
- `INVALID_JSON`: Request body is not valid JSON
- `VALIDATION_ERROR`: Config validation failed
- `GATEWAY_UNREACHABLE`: Cannot connect to LLM Gateway
- `FILE_ACCESS_ERROR`: Cannot read/write config file
- `NOT_FOUND`: Requested resource not found

---

## Gateway Connection

The WebAdmin backend connects to the LLM Gateway using the `GATEWAY_URL` environment variable (default: `http://localhost:3400`).

If the gateway is unreachable:
- Health endpoint returns degraded status
- Proxy endpoints return 503 with `GATEWAY_UNREACHABLE` error
- Dashboard shows offline indicator

---

*Version: 1.0*

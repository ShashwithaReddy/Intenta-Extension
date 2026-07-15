# Intenta AI Backend

Production-ready Express backend for Intenta AI intent classification.

## Install

```bash
npm install
```

## Development

Create a local `.env` file from `.env.example` and set `OPENAI_API_KEY`.

```bash
npm run dev
```

The development server uses:

```text
PORT=3001
NODE_ENV=development
```

## Production

```bash
npm start
```

For Render/Railway, configure environment variables in the platform dashboard.

## Environment Variables

```text
OPENAI_API_KEY=      Required. OpenAI API key used by the backend only.
NODE_ENV=           development or production.
PORT=               Server port. Render provides this automatically.
INTENTA_BETA_KEY=   Optional. If set, clients must send X-Intenta-Beta-Key.
```

Optional:

```text
INTENTA_ALLOWED_ORIGINS=https://your-extension-host.example
OPENAI_MODEL=gpt-4.1-mini
```

Chrome extension origins are allowed by default. Localhost origins are allowed in development.

## Health Check

```bash
curl http://localhost:3001/
```

Response:

```json
{
  "service": "Intenta AI Backend",
  "status": "healthy"
}
```

## Classify Intent

```bash
curl -X POST http://localhost:3001/classify-intent \
  -H "Content-Type: application/json" \
  -d '{
    "focusGoal": "Spring Boot learning",
    "pageType": "WEB_PAGE",
    "title": "Spring Boot REST API Tutorial",
    "url": "https://example.com/spring-boot",
    "domain": "example.com"
  }'
```

If `INTENTA_BETA_KEY` is configured, include:

```bash
-H "X-Intenta-Beta-Key: your-key"
```

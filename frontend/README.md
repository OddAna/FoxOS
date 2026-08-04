# FoxOS frontend

React/Vite desktop UI for FoxOS. Production builds are created by the root
`Dockerfile` and served by the backend as a same-origin application.

For local development:

```bash
npm ci
npm run dev
```

The development server proxies `/api` requests to
`http://localhost:3001`. See the root [README](../README.md) for the full
backend and deployment setup.

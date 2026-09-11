# Deploy the Device Bridge Worker

## Existing Worker

This configuration is intentionally named `throbbing-heart-25ef` so `wrangler deploy` targets your existing `throbbing-heart-25ef.ceaxres.workers.dev` Worker instead of creating a second Worker.

## Endpoint

- HTTPS: `https://throbbing-heart-25ef.ceaxres.workers.dev`
- WebSocket endpoint: `wss://throbbing-heart-25ef.ceaxres.workers.dev/ws`

Android base URL: `wss://throbbing-heart-25ef.ceaxres.workers.dev`
Windows base URL: `wss://throbbing-heart-25ef.ceaxres.workers.dev`

## Recommended deployment

From this `server/` folder, install Node.js and run:

```powershell
npm install
npx wrangler login
npx wrangler deploy
```

After deployment, open:

`https://throbbing-heart-25ef.ceaxres.workers.dev/`

The web dashboard should load. Then test:

`https://throbbing-heart-25ef.ceaxres.workers.dev/health`

The page has a small WebSocket test client.

## Important

The Cloudflare home-screen "Drop a folder, or a zip" upload is Cloudflare Drop for static assets. This project contains Worker code and a Durable Object, so use Wrangler or a Git-connected Worker build instead of uploading this project through the static-assets drop box.

## Custom domain later

When you have your own Cloudflare zone, attach a Custom Domain to the same Worker. Update the Android and Windows endpoint in one place and redeploy the clients.

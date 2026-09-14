# WP2PC Worker deployment

1. Create the R2 bucket once:
   `npx wrangler r2 bucket create wp2pc-backups`

2. Deploy:
   `npm install`
   `npx wrangler deploy`

3. Worker URL:
   `https://wp2pc.ceaxres.workers.dev`

4. WebSocket:
   `wss://wp2pc.ceaxres.workers.dev/ws`

The web app is served by the same Worker. R2 stores backup objects. The Worker never decrypts backup payloads.

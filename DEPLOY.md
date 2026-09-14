# Deploy

1. Enable R2 in Cloudflare Dashboard.
2. Create the bucket:

   npx wrangler r2 bucket create wp2pc-backups

3. Install dependencies:

   npm install

4. Check:

   npm run check

5. Test locally:

   npm run dev

6. Deploy:

   npm run deploy

The Worker is configured as `wp2pc` and uses `wp2pc-backups`.

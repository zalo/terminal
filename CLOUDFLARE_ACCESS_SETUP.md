# Cloudflare Zero Trust Access Setup for terminal.selst.uk

## Prerequisites

You need a Cloudflare API token with the following permissions:
- **Account**: `Access: Edit`
- **Zone**: `Zone: Read` (for DNS if managing via API)

## Step 1: Create Cloudflare API Token

1. Go to https://dash.cloudflare.com/profile/api-tokens
2. Click "Create Token"
3. Select "Custom token" > "Get started"
4. Configure:
   - **Token name**: `terminal-access-setup`
   - **Account permissions**:
     - Add `Access: Edit`
   - **Zone permissions**:
     - Add `Zone: Read`
5. Create token and copy it

## Step 2: Set Up Google OAuth App (Required for Identity)

1. Go to https://console.cloud.google.com/apis/credentials
2. Select your project (selstech)
3. Click "Create Credentials" > "OAuth client ID"
4. Application type: "Web application"
5. Name: `Cloudflare Access - terminal.selst.uk`
6. Authorized redirect URIs:
   - `https://<your-team-name>.cloudflareaccess.com/cdn-cgi/access/callback`
   - (Replace `<your-team-name>` with your Cloudflare Zero Trust team name)
7. Create and copy:
   - **Client ID**
   - **Client Secret**

## Step 3: Find Your Cloudflare Team Name

1. Go to https://dash.cloudflare.com/
2. Click on "Zero Trust" (or "Access" in the left sidebar)
3. Your team name is shown in the URL or settings
   - Example: if URL is `https://abc123.cloudflareaccess.com`, your team is `abc123`

## Step 4: Run the Setup Script

```bash
export CF_API_TOKEN="your-cloudflare-api-token"
export CF_TEAM_NAME="your-team-name"
export GOOGLE_CLIENT_ID="your-google-oauth-client-id"
export GOOGLE_CLIENT_SECRET="your-google-oauth-client-secret"

chmod +x /opt/terminal/setup-cloudflare-access.sh
/opt/terminal/setup-cloudflare-access.sh
```

## Manual Setup (if API approach fails)

If you prefer to configure manually in the Cloudflare dashboard:

### 1. Create Access Application
- Go to Zero Trust Dashboard > Access > Applications
- Click "Add an application"
- Type: Self-hosted
- Domain: `terminal.selst.uk`
- Session duration: 24 hours

### 2. Add Google Identity Provider
- Go to Zero Trust Dashboard > Settings > Authentication
- Under "Identity providers", click "Add new"
- Select "Google"
- Enter your Google OAuth client ID and secret

### 3. Create Access Policy
- In the application settings, go to "Access policies"
- Click "Add a policy"
- Name: `Allow shiftmaker and makeshifted`
- Action: Allow
- Include:
  - Add "Emails" > `shiftmaker@gmail.com`
  - Add "Emails" > `makeshifted@gmail.com`
- Save policy

## Testing

After setup, visit https://terminal.selst.uk
- You should be redirected to Google login
- Only shiftmaker@gmail.com and makeshifted@gmail.com will be allowed

## Troubleshooting

### "Invalid token" error
- Verify your API token has `Access: Edit` permission
- Check token hasn't expired

### Google login not appearing
- Ensure Google OAuth redirect URI matches your team name exactly
- Verify client ID/secret are correct

### Tunnel not routing
- Check tunnel is running: `sudo systemctl status terminal-server.service`
- Verify DNS: `dig terminal.selst.uk`

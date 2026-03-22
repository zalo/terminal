#!/bin/bash
# Cloudflare Zero Trust Access Setup for terminal.selst.uk
# This script configures:
#   1. Access application for terminal.selst.uk
#   2. Google as identity provider
#   3. Access policies for allowed emails only

set -e

# Check for API token
if [ -z "$CF_API_TOKEN" ]; then
    echo "Error: CF_API_TOKEN environment variable not set"
    echo "Please set it with: export CF_API_TOKEN='your-api-token'"
    exit 1
fi

# Account ID from the Argo Tunnel certificate
ACCOUNT_ID="52eac4774c41377ec9e4bf03f47a3205"

# API base URL
API_BASE="https://api.cloudflare.com/client/v4"

# Headers
AUTH_HEADER="Authorization: Bearer $CF_API_TOKEN"
CONTENT_TYPE="Content-Type: application/json"

echo "=== Configuring Cloudflare Zero Trust Access ==="

# Step 1: Create Access Application
echo ""
echo "Step 1: Creating Access Application for terminal.selst.uk..."
APP_RESPONSE=$(curl -s -X POST "$API_BASE/accounts/$ACCOUNT_ID/access/apps" \
    -H "$AUTH_HEADER" \
    -H "$CONTENT_TYPE" \
    -d '{
        "name": "terminal.selst.uk",
        "domain": "terminal.selst.uk",
        "type": "self-hosted",
        "session_duration": "24h",
        "jump_start": true
    }')

APP_ID=$(echo "$APP_RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('result', {}).get('id', ''))" 2>/dev/null || echo "")

if [ -z "$APP_ID" ]; then
    echo "Error creating app (may already exist): $APP_RESPONSE"
    # Try to get existing app ID
    APP_LIST=$(curl -s "$API_BASE/accounts/$ACCOUNT_ID/access/apps" -H "$AUTH_HEADER")
    APP_ID=$(echo "$APP_LIST" | python3 -c "import sys,json; d=json.load(sys.stdin); apps=d.get('result',[]); [print(a['id']) for a in apps if a.get('domain')=='terminal.selst.uk']" 2>/dev/null || echo "")
    if [ -z "$APP_ID" ]; then
        echo "Could not find or create application"
        exit 1
    fi
fi
echo "Access Application ID: $APP_ID"

# Step 2: Configure Google as Identity Provider
echo ""
echo "Step 2: Adding Google as Identity Provider..."
IDP_RESPONSE=$(curl -s -X POST "$API_BASE/accounts/$ACCOUNT_ID/access/identity_providers" \
    -H "$AUTH_HEADER" \
    -H "$CONTENT_TYPE" \
    -d '{
        "name": "Google",
        "type": "google",
        "config": {
            "client_id": "",
            "client_secret": "",
            "google_cookie_domain": "terminal.selst.uk"
        }
    }')

# Note: For Google OAuth, you need to configure:
# 1. Create OAuth app in Google Cloud Console
# 2. Use the client_id and client_secret in the config above
# 3. Set authorized redirect URI to: https://<your-team-name>.cloudflareaccess.com/cdn-cgi/access/callback

echo "Identity Provider setup: $IDP_RESPONSE"
echo "NOTE: For production use, configure Google OAuth app credentials in Google Cloud Console"

# Step 3: Create Access Policy
echo ""
echo "Step 3: Creating Access Policy for allowed emails..."

POLICY_RESPONSE=$(curl -s -X POST "$API_BASE/accounts/$ACCOUNT_ID/access/apps/$APP_ID/policies" \
    -H "$AUTH_HEADER" \
    -H "$CONTENT_TYPE" \
    -d '{
        "name": "Allow shiftmaker and makeshifted",
        "action": "allow",
        "principals": [
            {
                "email": "shiftmaker@gmail.com"
            },
            {
                "email": "makeshifted@gmail.com"
            }
        ],
        "include": [
            {
                "email": {
                    "list_type": "include",
                    "emails": ["shiftmaker@gmail.com", "makeshifted@gmail.com"]
                }
            }
        ],
        "exclude": [],
        "require": []
    }')

echo "Access Policy Response: $POLICY_RESPONSE"

echo ""
echo "=== Setup Complete ==="
echo "Access Application: terminal.selst.uk"
echo "Allowed users: shiftmaker@gmail.com, makeshifted@gmail.com"
echo ""
echo "Next steps:"
echo "1. Configure Google OAuth app in Google Cloud Console"
echo "2. Update the identity provider with your OAuth client_id and client_secret"
echo "3. Test access at https://terminal.selst.uk"

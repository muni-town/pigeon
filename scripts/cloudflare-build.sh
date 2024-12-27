#!/bin/env bash

npm i
npm ci
npm run build

cp -r public/* dist/public/
echo '{
  "client_id": "https://pigeon.muni.town/oauth-client.json",
  "client_name": "Localhost App",
  "client_uri": "https://pigeon.muni.town",
  "logo_uri": "https://pigeon.muni.town/public/favicon.ico",
  "tos_uri": "https://pigeon.muni.town",
  "policy_uri": "https://pigeon.muni.town",
  "redirect_uris": ["https://pigeon.muni.town/_matrix/custom/oauth/callback"],
  "scope": "atproto",
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "token_endpoint_auth_method": "none",
  "application_type": "web",
  "dpop_bound_access_tokens": true
}' > dist/oauth-client.json

echo '{
  "oauthClientId": "https://pigeon.muni.town/oauth-client.json",
  "defaultHomeserver": 0,
  "homeserverList": ["pigeon"],
  "allowCustomHomeservers": false,

  "featuredCommunities": {
    "openAsDefault": false
  },

  "hashRouter": {
    "enabled": false,
    "basename": "/"
  }
}' > dist/config.json
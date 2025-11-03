# Synergy game deployment files

Autho: Eric Xu

These files assume your server starts with `npm start` which runs `node server/index.js` and serves the `public` folder.

## Env var
- AI_URL: set to the URL of the deployed synergy-ai service if you use the AI opponent.

## Cloud Run deploy
gcloud run deploy synergy-game --source . --region us-west1 --allow-unauthenticated --set-env-vars AI_URL=<your-ai-url>

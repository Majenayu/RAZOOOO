# EventPay Sentinel

## Running the app

- Use the `Start application` workflow, or run `npm run dev` from the project root.
- The React/Vite frontend is served on port 5000.
- The Express API runs on port 3001.
- The API logs `MONGODB_URI not configured` until the MongoDB environment variables in `.env.example` are configured; the frontend remains available for the landing and auth screens.

## UI notes

The dashboard keeps the existing React/Vite structure and API contracts. Its shared visual system lives in `client/src/index.css`, with responsive navigation and layouts for desktop and mobile widths.
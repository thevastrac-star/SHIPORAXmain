# SHIPORAX — Deployment Instructions

## Your 3 Render Services
- **API Server:**    https://kourierwale.onrender.com      ← backend + database
- **Admin Panel:**   https://shiporaxadmin.onrender.com/  ← admin UI only
- **Client Panel:**  https://shiporaxclient.onrender.com/ ← client UI only

All 3 use the SAME codebase (this zip). Only the env vars differ.

---

## Service 1 — API Server (kourierwale)

This is your main backend. It serves all /api routes AND the MongoDB connection.

**Render Environment Variables:**
```
PORT=5000
NODE_ENV=production
MODE=both
MONGO_URI=mongodb+srv://Krist:Krist007@shippro.cjtrkrf.mongodb.net/kourierwale?appName=SHIPPRO
JWT_SECRET=de72c8fe625aa7001c8eeb938c96bbfbcda4c43ef589fcad003bdd9006df7a2f4d6fef2dde4158ea82ed7473a6b870a8861ecc3e6911c3507148467d71242041
JWT_EXPIRES_IN=7d
ADMIN_EMAIL=admin@kourierwale.com
ADMIN_PASSWORD=Admin@123456
BACKEND_URL=https://kourierwale.onrender.com
API_URL=https://kourierwale.onrender.com
```

**Start Command:** `node server.js`
**Root Directory:** `server/`

---

## Service 2 — Admin Panel (shiporaxadmin)

**Render Environment Variables:**
```
PORT=5000
NODE_ENV=production
MODE=admin
MONGO_URI=mongodb+srv://Krist:Krist007@shippro.cjtrkrf.mongodb.net/kourierwale?appName=SHIPPRO
JWT_SECRET=de72c8fe625aa7001c8eeb938c96bbfbcda4c43ef589fcad003bdd9006df7a2f4d6fef2dde4158ea82ed7473a6b870a8861ecc3e6911c3507148467d71242041
JWT_EXPIRES_IN=7d
ADMIN_EMAIL=admin@kourierwale.com
ADMIN_PASSWORD=Admin@123456
BACKEND_URL=https://shiporaxadmin.onrender.com
API_URL=https://kourierwale.onrender.com
```

**Start Command:** `node server.js`
**Root Directory:** `server/`

Result: https://shiporaxadmin.onrender.com/ → Admin Login page directly

---

## Service 3 — Client Panel (shiporaxclient)

**Render Environment Variables:**
```
PORT=5000
NODE_ENV=production
MODE=client
MONGO_URI=mongodb+srv://Krist:Krist007@shippro.cjtrkrf.mongodb.net/kourierwale?appName=SHIPPRO
JWT_SECRET=de72c8fe625aa7001c8eeb938c96bbfbcda4c43ef589fcad003bdd9006df7a2f4d6fef2dde4158ea82ed7473a6b870a8861ecc3e6911c3507148467d71242041
JWT_EXPIRES_IN=7d
ADMIN_EMAIL=admin@kourierwale.com
ADMIN_PASSWORD=Admin@123456
BACKEND_URL=https://shiporaxclient.onrender.com
API_URL=https://kourierwale.onrender.com
```

**Start Command:** `node server.js`
**Root Directory:** `server/`

Result: https://shiporaxclient.onrender.com/ → Client Login page directly

---

## What Each URL Shows

| URL | Opens |
|-----|-------|
| https://kourierwale.onrender.com/ | Old login (both panels) |
| https://shiporaxadmin.onrender.com/ | Admin Login only |
| https://shiporaxadmin.onrender.com/admin | Admin Dashboard |
| https://shiporaxclient.onrender.com/ | Client Login only |
| https://shiporaxclient.onrender.com/client | Client Dashboard |

---

## Bugs Fixed

1. **Nothing clickable** — `switchTab()` was crashing all JS with `event.target` bug. Fixed.
2. **API calls failing** — Frontend used `/api` (relative). Now uses `window.__API_URL` injected by server = `https://kourierwale.onrender.com`.
3. **Wrong panel at URL** — `MODE` env var now controls which panel each server shows.

---

## Login Credentials
- Admin: `admin@kourierwale.com` / `Admin@123456`
- Test Client: `client@test.com` / `client123`

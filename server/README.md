# SHIPORAX — GitHub + Render Deploy Guide

## GitHub Structure
```
shiporax/
├── .gitignore
├── README.md
└── server/               ← push this folder to GitHub
    ├── server.js
    ├── package.json
    ├── .gitignore
    ├── middleware/
    ├── models/
    ├── routes/
    ├── config/
    ├── utils/
    └── public/
        ├── login.html          ← combined login (kourierwale)
        ├── admin/
        │   ├── login.html
        │   └── index.html
        └── client/
            ├── login.html
            └── index.html
```

## Step 1 — Push to GitHub

```bash
cd shiporax/server
git init
git add .
git commit -m "shiporax v1"
git remote add origin https://github.com/YOUR_USERNAME/shiporax.git
git push -u origin main
```

**Root directory on Render = `server`**

---

## Step 2 — Render Services

You need **3 Web Services** on Render, all pointing to the SAME GitHub repo.
Each has different env vars.

### Service 1: kourierwale (API + fallback UI)
| Setting | Value |
|---|---|
| Root Directory | `server` |
| Build Command | `npm install` |
| Start Command | `node server.js` |

**Environment Variables:**
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

---

### Service 2: shiporaxadmin
| Setting | Value |
|---|---|
| Root Directory | `server` |
| Build Command | `npm install` |
| Start Command | `node server.js` |

**Environment Variables:**
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

---

### Service 3: shiporaxclient
| Setting | Value |
|---|---|
| Root Directory | `server` |
| Build Command | `npm install` |
| Start Command | `node server.js` |

**Environment Variables:**
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

---

## What Each URL Does

| URL | Shows |
|---|---|
| https://kourierwale.onrender.com/ | Combined login (both panels) |
| https://kourierwale.onrender.com/admin | Admin dashboard |
| https://kourierwale.onrender.com/client | Client dashboard |
| https://shiporaxadmin.onrender.com/ | Admin login only |
| https://shiporaxadmin.onrender.com/admin | Admin dashboard |
| https://shiporaxclient.onrender.com/ | Client login only |
| https://shiporaxclient.onrender.com/client | Client dashboard |

---

## Admin Login
- Email: `admin@kourierwale.com`
- Password: `Admin@123456`

## Test Client Login
- Email: `client@test.com`
- Password: `client123`

---

## Bugs Fixed
1. **Nothing clickable** — `api()` had no try/catch. If server returned HTML instead of JSON (Render sleep page, 404), `res.json()` threw and crashed ALL JavaScript on the page.
2. **API URL wrong** — Was defaulting to `http://localhost:5000` in production. Now uses `window.location.origin` as safe fallback, overridden by `API_URL` env var.
3. **switchTab crash** — Used global `event` variable which throws in modern browsers. Fixed.
4. **Wrong page at /** — Fixed with `MODE` env var per service.

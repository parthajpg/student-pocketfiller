# 🎓 Student Pocket Filler — Production Ready App

Survey earnings platform where students earn **50% of every survey payout**.

---

## Project Structure

```
moneyy/
├── server/          ← Node.js + Express backend (port 3001)
│   ├── index.js     ← Main server
│   ├── db.js        ← PostgreSQL connection
│   ├── schema.sql   ← Database tables
│   ├── seed.js      ← Creates admin user
│   ├── .env         ← Your secrets (never commit this)
│   ├── middleware/
│   │   └── auth.js
│   └── routes/
│       ├── auth.js       POST /api/auth/register,login,me
│       ├── surveys.js    POST /api/surveys/submit-code
│       ├── wallet.js     GET/POST /api/wallet
│       ├── admin.js      Admin dashboard & management
│       └── postback.js   GET /api/postback (CPX webhook)
├── index.html       ← Landing + Login/Signup
├── dashboard.html   ← Student survey dashboard
├── wallet.html      ← Earnings & withdrawals
├── leaderboard.html ← Top earners
├── profile.html     ← UPI & settings
├── admin.html       ← Admin panel (your panel)
├── css/style.css    ← Global styles
└── js/
    ├── app.js       ← Utilities (toast, formatters)
    └── api.js       ← All HTTP calls to backend
```

---

## Setup Guide

### Step 1 — Get Free PostgreSQL Database (Render)
1. Go to https://render.com → Sign up free
2. New → PostgreSQL → Name: `spf-db` → Free plan → Create
3. Copy the **External Database URL** (looks like `postgresql://...`)
4. Open `server/.env` → paste it as `DATABASE_URL=...`

### Step 2 — Run Schema + Create Admin User
```powershell
cd server
node seed.js
```
Output should show: `✅ PostgreSQL connected` and `✅ Admin user created`

### Step 3 — Start Backend Server
```powershell
cd server
npm start
```
Server runs at **http://localhost:3001**

### Step 4 — Start Frontend
Open a new terminal:
```powershell
cd ..   # back to moneyy/
npx serve . --listen 3000
```
Frontend at **http://localhost:3000**

---

## Admin Login
- URL: http://localhost:3000/admin.html
- Email: `admin@spf.com`
- Password: `admin123`

---

## Deploying to Production (Free)

### Backend → Render Web Service
1. Push your code to GitHub
2. Render → New Web Service → Connect GitHub repo
3. Root directory: `server`
4. Build command: `npm install`
5. Start command: `npm start`
6. Add environment variables (from `.env`)
7. Deploy → Copy your Render URL

### Frontend → Vercel
1. Open `js/api.js` line 4 → Replace `YOUR-RENDER-URL` with your actual Render URL
2. Push frontend files to GitHub
3. Vercel → New Project → Import → Deploy

---

## Adding CPX Research
Once you have your publisher account:
1. Get your **App ID** and **Hash Key** from CPX dashboard
2. In `js/app.js` → Replace `YOUR_CPX_APP_ID`
3. In `server/.env` → Replace `CPX_HASH_KEY`
4. Set postback URL in CPX dashboard to: `https://YOUR-RENDER-URL/api/postback`

---

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /api/auth/register | Student signup |
| POST | /api/auth/login | Login |
| GET  | /api/auth/me | Get current user |
| PUT  | /api/auth/update-upi | Update UPI ID |
| POST | /api/surveys/submit-code | Submit completion code |
| GET  | /api/surveys/my-submissions | My code history |
| GET  | /api/surveys/leaderboard | Top earners |
| GET  | /api/wallet | Wallet balance |
| GET  | /api/wallet/transactions | Transaction history |
| POST | /api/wallet/withdraw | Request withdrawal |
| GET  | /api/admin/dashboard | Admin stats |
| GET  | /api/admin/codes?status=pending | All code submissions |
| PUT  | /api/admin/codes/:id/approve | Approve → credit wallet |
| PUT  | /api/admin/codes/:id/reject | Reject submission |
| GET  | /api/admin/withdrawals | All withdrawals |
| PUT  | /api/admin/withdrawals/:id/pay | Mark as paid |
| PUT  | /api/admin/withdrawals/:id/reject | Reject + refund |
| GET  | /api/admin/users | All students |
| GET  | /api/postback | CPX Research webhook |

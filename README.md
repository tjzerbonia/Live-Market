# 📈 Forecast Markets

A Kalshi-style prediction market dashboard you can host on GitHub Pages. Users pick a nickname (no account needed), get a $1,000 play balance, and bet YES/NO on custom markets. All bets are stored in Firebase and reflected live for everyone who visits.

---

## 🗂 File Structure

```
kalshi-dashboard/
├── index.html   — page layout and markup
├── style.css    — all styles (dark theme)
├── app.js       — Firebase logic, market data, bet handling
└── README.md    — this file
```

---

## 🔧 Setup: Firebase

### 1. Create a Firebase project

1. Go to [https://console.firebase.google.com](https://console.firebase.google.com)
2. Click **Add project** → name it anything → click through the prompts
3. Disable Google Analytics if you don't need it

### 2. Enable Realtime Database

1. In your Firebase project, go to **Build → Realtime Database**
2. Click **Create Database**
3. Choose a region (us-central1 is fine)
4. Start in **test mode** for now (you can lock it down later)

### 3. Get your config keys

1. Go to **Project Settings** (gear icon) → **Your apps**
2. Click **Add app → Web** (the `</>` icon)
3. Register the app with any nickname
4. Copy the `firebaseConfig` object that appears

### 4. Paste your config into app.js

Open `app.js` and replace the placeholder block near the top:

```js
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  databaseURL: "https://YOUR_PROJECT-default-rtdb.firebaseio.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID"
};
```

---

## 🎯 Customizing Markets

Open `app.js` and find the `MARKETS` array near the top. Edit, add, or remove market objects:

```js
{
  id: "unique-market-id",       // lowercase, hyphenated, no spaces
  category: "NFL",              // displayed as a pill label
  title: "Will the Bears make the playoffs?",
  baseProb: 42,                 // starting YES probability (0–100)
  volume: 0,                    // leave at 0
},
```

The probability shifts slightly with each bet placed, reflecting crowd sentiment.

---

## 🚀 Deploying to GitHub Pages

### Option A: GitHub web interface (your preferred workflow)

1. Create a new GitHub repository (public)
2. Upload `index.html`, `style.css`, `app.js`, and `README.md` via **Add file → Upload files**
3. Go to **Settings → Pages**
4. Under **Source**, select **Deploy from a branch → main → / (root)**
5. Click Save — your site will be live at `https://yourusername.github.io/your-repo-name`

### Option B: Git command line

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git push -u origin main
```

Then enable Pages in repository Settings as above.

---

## 🔒 Locking Down Firebase (Optional but Recommended)

Once you're ready to go live, update your Realtime Database rules in the Firebase console (**Realtime Database → Rules**) to prevent abuse:

```json
{
  "rules": {
    "bets": {
      ".read": true,
      ".write": true,
      "$betId": {
        ".validate": "newData.hasChildren(['userId','userName','marketId','side','amount'])"
      }
    },
    "market_probs": {
      ".read": true,
      ".write": true
    }
  }
}
```

For tighter security (prevent spam), you can add Firebase Authentication later.

---

## 💡 How It Works

- **Nickname**: On first visit, users enter a display name. A UUID + name is saved to `localStorage` — no login required, but they get a consistent identity.
- **Balance**: Each user starts with $1,000 in play money, stored locally (resets if they clear browser storage).
- **Bets**: Stored in Firebase under `/bets`. The activity feed subscribes to this in real time.
- **Probabilities**: Stored under `/market_probs/{marketId}`. Each bet nudges the probability slightly toward the chosen side (max 2% per bet).

---

## 🛠 Ideas for Future Improvements

- Add an admin panel to resolve markets (mark YES/NO as final and pay out winners)
- Add user leaderboard ranked by balance
- Add a "My Bets" panel per user
- Lock betting after a market resolves
- Add Firebase Auth for persistent cross-device balances

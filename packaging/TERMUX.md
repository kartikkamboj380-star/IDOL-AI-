# IDOL AI on Termux (Android)

Yeh guide un logon ke liye hai jo app ko phone par chalana chahte hain, laptop ke
bina. Sab kuch phone ke andar hota hai — koi server nahi, koi account nahi.

Package **pure JavaScript** hai: `node_modules` mein ek bhi native `.node` binary
nahi hai, isliye ARM64 Termux par yeh bina recompile ke chalta hai.

---

## 1. Termux install karein

Play Store wala Termux **purana** hai aur packages fail karta hai. F-Droid ya
GitHub se lein:

- F-Droid: https://f-droid.org/packages/com.termux/
- GitHub releases: https://github.com/termux/termux-app/releases

## 2. Node.js install karein

```bash
pkg update && pkg upgrade -y
pkg install nodejs-lts -y
node -v
```

`v20.11` ya usse naya hona chahiye. Agar purana ho to:

```bash
pkg install nodejs-lts
```

## 3. Package download karein

```bash
pkg install curl unzip -y
cd ~
curl -L -o idol.zip https://github.com/kartikkamboj380-star/IDOL-AI-/releases/latest/download/idol-ai-<version>.zip
unzip -q idol.zip
cd idol-ai-<version>
```

## 4. Chalayein

```bash
node start.mjs
```

Screen par yeh aayega:

```
  IDOL AI
  ────────────────────────────────────────
  Open:   http://localhost:8787
  Mode:   knowledge (no model required)
  Stop:   Ctrl+C
```

Ab **phone ka browser** kholein aur `http://localhost:8787` par jayein.
Bas. Band karne ke liye Termux mein `Ctrl+C` (Termux keyboard mein `Ctrl` + `c`).

---

## Pehle check karna ho to

```bash
node scripts/verify.mjs
```

Yeh 10 checks chalata hai. Sab `PASS` aana chahiye. Agar koi `FAIL` aaye to
neeche "Problems" dekhein.

---

## Problems aur hal

| Problem | Hal |
| --- | --- |
| `node: command not found` | `pkg install nodejs-lts` |
| `Node.js 18.x is too old` | `pkg install nodejs-lts` (18 ki jagah 20+) |
| `unzip: command not found` | `pkg install unzip` |
| `Cannot find module 'express'` | `cd idol-ai-<version> && npm install --omit=dev` (ek baar, internet chahiye) |
| Port 8787 busy | `node start.mjs 9000` |
| Browser mein kuch nahi khulta | Termux mein server chal raha hai? `node start.mjs` dobara chalayein |
| Doosre phone/PC se kholna hai | `node start.mjs` chalayein, phir `ifconfig` se apna `192.168.x.x` dekhein, aur wahan se `http://192.168.x.x:8787` kholein |

### Battery aur background

Android Termux ko background mein maar deta hai. Server chalta rahe iske liye:

```bash
termux-wake-lock
```

Band karne ke liye `termux-wake-unlock`. Yeh sirf tab chahiye jab aap app ko
background mein chalte hue rakhna chahte hain.

### Storage

Index `idol-ai-<version>/.data/` mein banta hai. Chhota hai — demo corpus ke liye
~250 KB. Agar aap bada repo index karein to badhega. Delete karein to app agli
baar dobara index kar lega:

```bash
rm -rf .data
```

---

## Apna GitHub repo index karna

Package ke saath ek demo corpus aata hai. Apna content add karne ke liye:

```bash
cp .env.example .env
```

Phir `.env` mein:

```bash
# Local folder (phone par):
IDOL_LOCAL_DIR=/data/data/com.termux/files/home/mera-project

# Ya GitHub repo (public):
IDOL_DEFAULT_REPO=owner/repo

# Private repo ke liye:
GITHUB_TOKEN=github_pat_xxx
```

Termux mein home path `/data/data/com.termux/files/home` hota hai — poora path
likhein, `~` nahi chalega.

---

## Yeh Termux par theek chalega?

Haan, kyunki isme koi native module nahi hai. Lekin do baatein imaandari se:

- **Speed.** Phone ka CPU laptop se dheema hai. Demo corpus (22 files) par index
  ~50ms mein banta hai, isliye fark nahi padega. Hazaaron files wale bade repo par
  indexing mein kuch second lagenge.
- **Screen.** UI mobile ke liye banaya gaya hai, par chhoti screen par bade code
  tables squeeze honge. Phone ko landscape mein ghumana behtar rehta hai.

Agar bada repo index karna hai to laptop/VPS behtar hai — phone par sirf padhne ke
liye theek hai.

---

## Poore app ki tarah, ek baat saaf

Yeh app **knowledge mode** mein chalta hai: jawab aapke sources ke asli passages se
bante hain, exact file aur line number ke saath, aur neeche likha aata hai
*"No language model was used."* Yeh general chatbot nahi hai — repo ke sawaalon
mein sahi hai, kavita nahi likhega.

Uske liye inference mode alag hai — `.env` mein apna API endpoint daalein, phir
wahi evidence se fluent jawab banta hai (aur citations phir bhi verify hote hain).

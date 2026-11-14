# IDOL AI — downloadable package

Repo ke docs ke sawaalon ka jawab, exact **file aur line number** ke saath. Sab kuch
aapke computer par chalta hai: koi account nahi, koi API key nahi, koi subscription nahi.

---

## Kaise chalayein (2 steps)

**Zaroorat:** Node.js 20.11 ya usse naya — https://nodejs.org (LTS version).

```bash
unzip idol-ai-<version>.zip      # ya: tar -xzf idol-ai-<version>.tar.gz
cd idol-ai-<version>

node start.mjs
```

Browser mein kholein: **http://localhost:8787**

Band karne ke liye `Ctrl+C`.

Dusra port chahiye to:

```bash
node start.mjs 9000     # → http://localhost:9000
```

Pehle check karna ho ki package theek hai:

```bash
node scripts/verify.mjs
```

Ye 10 checks chalata hai (server, index, UI, search, chat, citations, security
headers) aur har check ke saamne PASS/FAIL dikhata hai. Sab PASS aana chahiye.

## Andar kya hai

```
start.mjs              one-command starter
dist/                  built UI (HTML/CSS/JS)
dist-server/           compiled backend
node_modules/          saari zaroori dependencies (offline chalega)
data/                  query-expansion vocabulary
huggingface/           demo corpus — sample documentation jo search hoti hai
docs/
  ARCHITECTURE.md      poora design: retrieval, ranking, validation
  LIMITATIONS.md       kya ye nahi kar sakta (padh lena)
scripts/verify.mjs     self-check
.env.example           saari optional settings
```

`node_modules` include hai, isliye **internet ki zaroorat nahi**. Agar aapke unzip
tool ne `node_modules` skip kar diya, to ek baar chala lein:

```bash
npm install --omit=dev
```

## Ye actually karta kya hai

Aap sawaal poochte hain. Ye app pehle **aapke repo se asli passages dhoondta hai**,
phir unhi passages se jawab banata hai, aur har claim ke saath `[1]` jaisa citation
deta hai jise click karke aap source file aur exact line range dekh sakte hain.

Agar repo mein jawab nahi hai, to ye **saaf mana kar deta hai** — jo terms search
kiye wo bata deta hai — bajaye iske ki kuch bana ke bol de.

Do modes hain:

| Mode | Kya hota hai |
| --- | --- |
| **Knowledge** (default) | Jawab repo ke asli vaakyon/tables se banta hai. Har jawab ke neeche likha hota hai *"No language model was used"*. |
| **Inference** (optional) | Aap apna OpenAI-compatible endpoint lagayein to jawab LLM likhta hai, wahi retrieved passages se. Citations phir bhi validate hote hain. |

Default mode jaan-boojh kar imaandar hai: ye koi general-purpose chatbot hone ka
dawa nahi karta. "Is repo mein X ke baare mein kya likha hai" — ismein ye bahut
accha hai. Kavita nahi likhega.

## Apna repo search karwaayein

Package ke saath demo corpus (`huggingface/`) aata hai. Apna content daalne ke liye
`.env.example` ko `.env` banayein aur ye set karein:

```bash
IDOL_LOCAL_DIR=/aapka/project/path        # local folder index karein
# ya
IDOL_DEFAULT_REPO=owner/repo             # GitHub repo (public chalega)
GITHUB_TOKEN=github_pat_xxx              # sirf private repo ke liye, ya rate limit badhane
```

UI ke **Knowledge sources** dialog se bhi repo add/remove/re-index kar sakte hain.

## Common problems

| Problem | Hal |
| --- | --- |
| `node: command not found` | Node.js 20.11+ install karein — https://nodejs.org |
| `node_modules is missing` | `npm install --omit=dev` (ek baar, internet chahiye) |
| Port pehle se busy | `node start.mjs 9000` |
| GitHub source `error` dikha raha | Public repo ke liye bhi rate limit hit ho sakta hai — `GITHUB_TOKEN` set karein. Private repo ke bina token access nahi hoga. |
| `UNABLE_TO_VERIFY_LEAF_SIGNATURE` | Office/corporate proxy ka CA add karein: `NODE_EXTRA_CA_CERTS=/path/to/ca.pem` |

## Honest limitations (chhota version)

- Search **lexical** hai (BM25), semantic embeddings nahi. Alag shabdon mein poocha
  to kabhi miss ho sakta hai — tab ye mana kar dega, galat jawab nahi dega.
- Sirf text files. Model weights, images, binaries padhe nahi jaate (LFS pointer
  detect karke report kiya jata hai, "analyzed" ka dawa nahi).
- Code analysis pattern-based hai — security audit nahi.
- Conversations browser ke localStorage mein hain. Site data clear kiya to chali gayi.
- **Ye ek long-running Node process hai** jo disk par index rakhta hai aur memory
  mein cache karta hai. Isliye ise VPS / Docker / Render / Railway / Fly.io par
  chalayein — kisi bhi aise jagah jahan Node process chal sakta ho.

Poori list: `docs/LIMITATIONS.md`

## License

MIT — `LICENSE` dekhein. `huggingface/` ka demo corpus alag project ka hai, sirf
sample documentation ke taur par shaamil hai.

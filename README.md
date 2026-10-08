# Izla — qidiruv algoritmi (teskari indeks + TF-IDF + kosinus)

Statik sayt (React CDN orqali). Build kerak emas.

## Lokal ishga tushirish
`start.bat` ni ishga tushiring -> http://localhost:5173

## Vercel'ga deploy
1. Papkani GitHub'ga yuklang (yoki `vercel` CLI ishlating).
2. vercel.com -> Add New -> Project -> reponi tanlang.
3. Framework Preset: **Other**. Build Command va Output Directory — bo'sh qoldiring. Deploy.

CLI bilan: `npm i -g vercel` so'ng shu papkada `vercel --prod`.

## Tuzilma
- `index.html` — kirish nuqtasi
- `src/engine.js` — algoritm (indekslash, TF-IDF, kosinus)
- `src/app.jsx`, `src/styles.css` — interfeys
- `data/docs/*.txt` — hujjatlar, `data/docs.json` — ro'yxat, `data/stopwords.txt`

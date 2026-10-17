# Es-makker whist

Webbaseret es-makker whist til fire spillere: venterum, ét bord med valgfrie meldinger, Klar-knap med nedtælling,
pause ved mistet forbindelse, gem/genoptag bord samt historik og statistik i en SQLite-database.

## Kør lokalt

Kræver Node.js 22.13 eller nyere (SQLite er indbygget i Node).

```sh
npm install
npm start          # http://localhost:3000
npm test           # tests af spilmotoren
```

Simulér fire spillere mod en kørende server (godt til at afprøve ændringer):

```sh
node tools/simulate.js http://localhost:3000 5
```

Miljøvariabler:

| Variabel   | Standard         | Betydning              |
|------------|------------------|------------------------|
| `PORT`     | `3000`           | Port serveren lytter på |
| `WHIST_DB` | `data/whist.db`  | Sti til databasen       |

## Drift på Linux-server

1. Installer Node.js 22 LTS eller nyere, kopiér projektet til fx `/opt/whist`, og kør `npm ci --omit=dev`.
2. Opret en systemd-service, `/etc/systemd/system/whist.service`:

   ```ini
   [Unit]
   Description=Es-makker whist
   After=network.target

   [Service]
   WorkingDirectory=/opt/whist
   ExecStart=/usr/bin/node server/index.js
   Environment=PORT=3000
   Restart=always
   User=whist

   [Install]
   WantedBy=multi-user.target
   ```

   `sudo systemctl enable --now whist`

3. Sæt en reverse proxy med HTTPS foran. Med [Caddy](https://caddyserver.com) er det to linjer i `Caddyfile`
   (Caddy henter selv et certifikat og håndterer websockets):

   ```
   whist.ditdomæne.dk {
       reverse_proxy localhost:3000
   }
   ```

   HTTPS er også nødvendigt for webcam-funktionen senere, da browsere kun giver adgang til kamera på sikre sider.

Databasen ligger i `data/whist.db`. Tag backup af den mappe.

## Struktur

```
server/
  index.js    webserver, venterum, bord, pause/gem (Socket.IO)
  game.js     spilmotor: melderunde, makker-es, vip, kat, stikspil
  bids.js     meldinger, rangorden og standardregler
  scoring.js  pointberegning
  db.js       SQLite: spillere, spilleaftener, runder, point, statistik
public/       klienten (ren HTML/CSS/JS, intet byggetrin)
test/         tests af spilmotoren
tools/        simulering med fire bots
```

## Regler

Reglerne følger [Wikipedia](https://da.wikipedia.org/wiki/Whist) og jeres variant. Hvor reglerne var uklare, er der
valgt følgende, som er bekræftet (alt kan justeres i `server/bids.js`, `server/game.js` og `server/scoring.js`):

- **Påhæng, lav → høj:** vip < halve < stærke < gode < trumfløse < kvarte. Ethvert påhæng på N slår N, men ikke N+1
  (kvarte har altså ikke den særlige "7 kvarte slår 9"-regel).
- **Nolo:** sol (9–9+), ren sol (10–10+), bordlægger (11–11+) og ren bordlægger (12–12+). Alle er med som standard.
- **Holde:** en spiller tidligere i melderunden må melde det samme som en senere spiller.
- **Alle passer:** der gives om, og giveren rykker en plads.
- **Jokere:** højeste trumfer, og den første joker i stikket vinder. En joker spillet ud kræver trumf. I spil uden
  trumf kan en joker altid spilles, men den vinder aldrig stikket.
- **Katten:** man tager hele katten og lægger 3 kort, eller beholder sine kort.
- **Point:** vundet = grundpoint × (1 + overstik), tabt = grundpoint × manglende stik. Påhæng ×2. Vip'1/2/3 ×2/×4/×8
  (klør vendt ×2). Selvmakker (kaldt eget es) ×2. Esset i katten giver ingen fordobling. Med makker får eller betaler
  begge makkere pointene. Spiller man alene, betaler hver modspiller, og melderen får 3×.
- Endnu ikke understøttet: "gå med" på vip og sol, fordækt kort, kald af konge ved fire esser og jernhånd
  (se `todo.md`).

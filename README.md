# Es-makker whist

Webbaseret es-makker whist til fire spillere: venterum, ét bord med valgfrie meldinger, Klar-knap med nedtælling,
pause ved mistet forbindelse, gem/genoptag bord samt historik og statistik i en SQLite-database.

Hver runde gemmes med alle uddelte kort, katten, hvert bud og hvert spillet kort – inklusive spillerens
betænkningstid (fra turen begyndte, til valget blev truffet). Under "Stilling" og "Historik" kan en runde afspilles
bud for bud og kort for kort: afspil/pause, frem og tilbage, tre hastigheder (> = 2 sek., >> = 1 sek., >>> = 0,4 sek.
mellem hvert trin) og et flueben pr. spiller, der viser eller skjuler kortene. Det er godt til træning.

## AI-spillere

Ledige pladser ved bordet kan fyldes med AI-spillere, så man kan spille (eller teste) uden fire mennesker:

| Profil    | Melder                                         | Spiller                         |
|-----------|------------------------------------------------|---------------------------------|
| Forsigtig | lavt og sikkert, sjældent nolo                 | få fejl (2 % af kortene)        |
| Normal    | realistisk                                     | nogle fejl (5 % af kortene)     |
| Vovehals  | et stik over evne, går gerne efter sol         | tager chancer (8 % af kortene)  |

En "fejl" er indtil videre et tilfældigt lovligt kort i stedet for det kort, AI'en ellers ville vælge.

AI'en ser kun sin egen hånd og det, der er offentligt ved bordet (meldinger, spillede kort, kendt makker). Den
vurderer hånden med tommelfingerregler (`server/ai.js`), kalder esset i sin længste farve, trækker trumf når den
har topkortene, lader makker beholde et sikkert stik, og dukker under i sol. AI-spillere gemmes i databasen som
almindelige spillere (`AI Forsigtig` osv.), så de også optræder i stilling og historik.

## Kør lokalt

Kræver Node.js 22.13 eller nyere (SQLite er indbygget i Node).

```sh
npm install
npm start          # http://localhost:3000
npm test           # tests af spilmotoren
```

Simulér spillere mod en kørende server (godt til at afprøve ændringer):

```sh
node tools/simulate.js http://localhost:3000 5      # fire spillere med tilfældige træk
node tools/simulate.js http://localhost:3000 5 ai   # én spiller + tre AI-spillere
```

Miljøvariabler:

| Variabel   | Standard         | Betydning              |
|------------|------------------|------------------------|
| `PORT`     | `3000`           | Port serveren lytter på |
| `WHIST_DB` | `data/whist.db`  | Sti til databasen       |
| `WHIST_DELAY_FACTOR` | `1` | Gang alle ventetider (AI, score) med dette tal – fx `0.05` under test |

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

Databasen ligger i `data/whist.db`. Tag backup af den mappe. Spillets tilstand gemmes efter hver handling, så et
spil kan genoptages præcis hvor det slap – også efter en servergenstart (det ligger så under "Gemte borde").

## Database

| Tabel             | Indhold                                                                    |
|-------------------|----------------------------------------------------------------------------|
| `players`         | Spillere (navnet er nøglen, ingen kodeord); `bot_profile` er sat for AI      |
| `sessions`        | Spilleaftener: start/slut, status (active/saved/ended), regler, gemt tilstand |
| `session_players` | Hvem sad på hvilken plads                                                  |
| `rounds`          | Én række pr. spillet runde: melder, makker, melding, trumf, stik, vundet + `replay` (JSON) |
| `round_scores`    | Point pr. spiller pr. runde                                                |
| `round_hands`     | De 13 kort hver spiller fik (fx `S14 H2 J1`; S/H/C/D + 2–14, J = joker)     |
| `round_bids`      | Hvert bud i melderunden (NULL = pas) med betænkningstid i ms               |
| `round_plays`     | Hvert spillet kort: rækkefølge, stik nr., spiller, kort, om det vandt stikket, betænkningstid i ms |

Eksempel – hvor mange stik har hver spiller vundet:

```sql
SELECT p.name, COUNT(*) FROM round_plays rp JOIN players p ON p.id = rp.player_id
WHERE rp.won_trick = 1 GROUP BY p.id;
```

## Struktur

```
server/
  index.js    webserver, venterum, bord, pause/gem (Socket.IO)
  game.js     spilmotor: melderunde, makker-es, vip, kat, stikspil
  bids.js     meldinger, rangorden og standardregler
  scoring.js  pointberegning
  ai.js       AI-spillere med tre risikoprofiler
  db.js       SQLite: spillere, spilleaftener, runder, point, statistik
public/       klienten (ren HTML/CSS/JS, intet byggetrin)
  cards/classic/  klassiske kort som SVG (CC0, se LICENSE.txt i mappen)
test/         tests af spilmotoren
tools/        simulering med fire bots
```

## Regler

Reglerne følger [Wikipedia](https://da.wikipedia.org/wiki/Whist) og jeres variant. Hvor reglerne var uklare, er der
valgt følgende, som er bekræftet (alt kan justeres i `server/bids.js`, `server/game.js` og `server/scoring.js`):

- **Påhæng, lav → høj:** vip < halve < stærke < gode < trumfløse < kvarte. Ethvert påhæng på N slår N, men ikke N+1
  (kvarte har altså ikke den særlige "7 kvarte slår 9"-regel).
- **Nolo:** sol (9–9+), ren sol (10–10+), bordlægger (11–11+) og ren bordlægger (12–12+). Alle er med som standard.
- **Holde:** en spiller tidligere i melderunden må melde det samme som en senere spiller. Reglen er slået til som
  standard og kan slås fra af bordets ejer.
- **Alle passer:** der gives om, og giveren rykker en plads.
- **Jokere:** højeste trumfer, og den første joker i stikket vinder. En joker spillet ud kræver trumf. I spil uden
  trumf kan en joker altid spilles, men den vinder aldrig stikket.
- **Katten:** man tager hele katten og lægger 3 kort, eller beholder sine kort.
- **Point:** vundet = grundpoint × (1 + overstik), tabt = grundpoint × manglende stik. Påhæng ×2. Vip'1/2/3 ×2/×4/×8
  (klør vendt ×2). Selvmakker (kaldt eget es) ×2. Esset i katten giver ingen fordobling. Med makker får eller betaler
  begge makkere pointene. Spiller man alene, betaler hver modspiller, og melderen får 3×.
- Endnu ikke understøttet: "gå med" på vip og sol, fordækt kort, kald af konge ved fire esser og jernhånd
  (se `todo.md`).

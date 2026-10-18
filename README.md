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

Koden går via et privat GitHub-repo: udviklingsmaskinen pusher, og serverne henter selv. Serverne skal altså kun
kunne komme *ud* på internettet – ingen indgående forbindelser. Samme fremgangsmåde bruges på test-serveren og
hosting-serveren.

```
udviklingsmaskine ──git push──▶ github.com/HellGreen/whist ◀──git fetch── server (sudo /opt/whist/update.sh)
```

### Første gang på udviklingsmaskinen

Opret et tomt, privat repo `whist` på github.com (uden README), og push:

```sh
git remote add origin https://github.com/HellGreen/whist.git
git push -u origin main
```

Derefter er det bare `git push` efter hver commit, der skal ud på serverne.

### Første gang på en server

Alle kommandoer køres i en terminal på serveren.

1. Installer git og Node.js 22 LTS eller nyere, og opret en systembruger, som spillet kører som:

   ```sh
   sudo apt install git     # Node.js 22: se https://nodejs.org/en/download (fx via NodeSource)
   sudo useradd --system --home /opt/whist --shell /usr/sbin/nologin whist
   ```

2. Lav en nøgle, som serveren kan læse repoet med (en *deploy key* – den giver kun læseadgang til dette ene repo):

   ```sh
   sudo mkdir -p /etc/whist
   sudo ssh-keygen -t ed25519 -N '' -C "whist@$(hostname)" -f /etc/whist/github_key
   sudo chown -R whist: /etc/whist
   ```

   `ssh-keygen` skriver en del linjer (fingerprint og "randomart") – dem skal du ikke bruge. Vis i stedet den
   offentlige nøgle:

   ```sh
   sudo cat /etc/whist/github_key.pub
   ```

   Den skriver præcis én linje, fx `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA...Qw whist@testserver`. Kopiér hele
   linjen – også `ssh-ed25519` forrest og `whist@...` bagerst (det er bare en kommentar, der viser hvilken server
   nøglen hører til). På GitHub: repoet → *Settings* → *Deploy keys* → *Add deploy key*. *Title*: fx
   `test-server`. *Key*: linjen. Lad "Allow write access" være slået fra. Hver server har sin egen nøgle.

3. Hent koden til `/opt/whist`:

   ```sh
   SSHCMD="ssh -i /etc/whist/github_key -o IdentitiesOnly=yes -o UserKnownHostsFile=/etc/whist/known_hosts -o StrictHostKeyChecking=accept-new"
   sudo mkdir -p /opt/whist && sudo chown whist: /opt/whist
   sudo -u whist -H git -c core.sshCommand="$SSHCMD" clone git@github.com:HellGreen/whist.git /opt/whist
   sudo -u whist git -C /opt/whist config core.sshCommand "$SSHCMD"
   ```

   `/opt/whist` skal være tom (eller ikke findes), før `clone`. Ligger der noget fra et tidligere forsøg, så flyt
   det væk – men gem `data/`, hvis der er en database, du vil beholde, og læg den tilbage bagefter.

   Blokerer netværket udgående port 22, så brug GitHubs ssh på port 443 i stedet: erstat
   `git@github.com:HellGreen/whist.git` med `ssh://git@ssh.github.com:443/HellGreen/whist.git`.

4. Opret en systemd-service, `/etc/systemd/system/whist.service`:

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

   Node skal være installeret for hele systemet i `/usr/bin/node` (tjek med `/usr/bin/node --version`). En node
   fra nvm i din egen hjemmemappe virker ikke: `whist`-brugeren kan ikke læse den, og `sudo` finder ikke dens
   `npm`. På Ubuntu/Debian:

   ```sh
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
   sudo apt install -y nodejs
   ```

5. Slå servicen til, og start spillet:

   ```sh
   sudo systemctl daemon-reload
   sudo systemctl enable whist
   sudo /opt/whist/update.sh
   ```

   Spillet svarer nu på `http://localhost:3000` på serveren (og `http://<serverens-ip>:3000` fra andre maskiner på
   samme netværk, hvis firewallen tillader det). Det er nok på test-serveren.

6. Kun på serveren, der skal kunne nås udefra: sæt en reverse proxy med HTTPS foran. Med
   [Caddy](https://caddyserver.com) er det to linjer i `Caddyfile` (Caddy henter selv et certifikat og håndterer
   websockets):

   ```
   whist.ditdomæne.dk {
       reverse_proxy localhost:3000
   }
   ```

   HTTPS er også nødvendigt for webcam-funktionen senere, da browsere kun giver adgang til kamera på sikre sider.
   Domænet skal pege på serveren, og port 80 og 443 skal være åbne, så Caddy kan hente certifikatet. Port 3000
   skal ikke være åben udadtil.

### Opdatering

Push fra udviklingsmaskinen, og kør så på serveren:

```sh
sudo /opt/whist/update.sh                       # nyeste main
sudo WHIST_BRANCH=afprøvning /opt/whist/update.sh   # en anden gren, fx på test-serveren
```

Scriptet henter koden fra GitHub, kører `npm ci --omit=dev` og genstarter servicen. Kun det, der er pushet, kommer
med, og `data/` på serveren røres ikke.

### Databasen

Databasen følger ikke med (`data/` er i `.gitignore`), så en ny server starter med en tom database. Skal en
eksisterende database med, så få filen `whist.db` over på serveren (USB, scp fra en maskin på samme netværk e.l.),
fx til `/tmp/whist.db`, og kør:

```sh
sudo systemctl stop whist
sudo rm -f /opt/whist/data/whist.db-wal /opt/whist/data/whist.db-shm
sudo install -o whist -g whist -m 640 -D /tmp/whist.db /opt/whist/data/whist.db
sudo systemctl start whist
```

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
- **Holde:** en spiller tidligere i melderunden må melde det samme som en senere spiller (ikke ved nolo).
- **Gå med:** på en nolo-melding kan de andre gå med i stedet for at melde højere – knappen med samme melding
  hedder så fx "Sol (går med)". De spiller samme melding hver for sig, og resten prøver at vælte dem alle. Melderen bytter først med katten; derefter kan den næste der gik
  med bytte med de 3 kort, melderen lagde, osv. Runden fortsætter, til alle nolo-spillere er gået ned eller 13
  stik er spillet. Point med to nolo-spillere (grundpoint P): går én hjem og én ned, dækker taberen alene
  vinderens fulde beløb (3P). Går begge ned, betaler hver P til en modspiller. Går begge hjem, betaler hver
  modspiller P til en vinder. Reglen er slået til som
  standard og kan slås fra af bordets ejer.
- **Alle passer:** der gives om, og giveren rykker en plads.
- **Jernhånd:** en spiller uden billedkort (B, D, K), esser og jokere kan, når det er vedkommendes tur til at melde,
  kræve at der gives om (giveren rykker en plads, som når alle passer). Slået til som standard; bordets ejer kan
  slå den fra. AI-spillere kræver det kun, hvis de ellers ville passe.
- **Jokere:** en joker spillet ud som første kort er et sikkert stik, og de andre må lægge hvad som helst. Spilles
  den ikke ud, har den ingen værdi og må kun lægges, når man ikke kan bekende kulør. Jokere kan ikke spilles ud i
  første stik.
- **Alle fire esser:** har melderen alle fire esser, er melderen selvmakker. Man kan ikke kalde en konge i stedet.
- **Katten:** man tager hele katten og lægger 3 kort, eller beholder sine kort.
- **Fordækt kort:** har melderen ingen kort i makker-essets kulør (efter katten), skal vedkommende inden første
  udspil lægge et vilkårligt kort fordækt – også en joker. Kortet tæller som laveste kort i
  essets kulør og må kun bruges til at spille ud i kuløren (til makker-esset) eller lægges, første gang kuløren
  spilles – aldrig smides på en anden kulør. Det vises aldrig for bordet, kun i resultatet efter runden.
- **Esset i nolo:** i sol, ren sol, bordlægger og ren bordlægger tæller esset som 1 (laveste kort).
- **Point:** vundet = grundpoint × (1 + overstik), tabt = grundpoint × manglende stik. Påhæng ×2. Vip'1/2/3 ×2/×4/×8
  (klør vendt ×2). Selvmakker (kaldt eget es) ×2. Esset i katten giver ingen fordobling. Med makker får eller betaler
  begge makkere pointene. Spiller man alene, betaler hver modspiller, og melderen får 3×.

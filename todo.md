# TODO

- [ ] Snak om hvilke typer fejl AI-spillerne skal lave (i dag: et tilfældigt lovligt kort i 2 % / 5 % / 8 % af
      kortene for Forsigtig / Normal / Vovehals – se `gamble` i `server/ai.js`)
- [ ] Vælg korttema ved bordet (kun for spilleren selv). Temaerne findes allerede: `classic` og `simple`
      i `public/app.js` (gemmes i localStorage under `whist.cards`) – der mangler kun en vælger i brugerfladen
- [ ] Webcam: hver spiller kan aktivere sit webcam, som vises under spillerens navn ved bordet
      (der er allerede en tom `.cam`-plads under navnet i `public/app.js`; kræver HTTPS og WebRTC)
- [ ] Fordækt kort, når melderen ikke har kort i makker-essets kulør
- [ ] Kald af konge, når melderen har alle fire esser
- [ ] Jernhånd (ingen billedkort, esser eller jokere → giv om)
- [ ] Vis sidste stik på knap/tryk
- [ ] Automatisk gem af bordet, hvis alle spillere har været væk længe

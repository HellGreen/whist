# TODO

- [ ] Snak om hvilke typer fejl AI-spillerne skal lave (i dag: et tilfældigt lovligt kort i 2 % / 5 % / 8 % af
      kortene for Forsigtig / Normal / Vovehals – se `gamble` i `server/ai.js`)
- [ ] Vælg korttema ved bordet (kun for spilleren selv). Temaerne findes allerede: `classic` og `simple`
      i `public/app.js` (gemmes i localStorage under `whist.cards`) – der mangler kun en vælger i brugerfladen
- [ ] Webcam: hver spiller kan aktivere sit webcam, som vises under spillerens navn ved bordet
      (der er allerede en tom `.cam`-plads under navnet i `public/app.js`; kræver HTTPS og WebRTC)
- [ ] Fordækt kort, når melderen ikke har kort i makker-essets kulør
- [ ] Kald af konge, når melderen har alle fire esser
- [ ] Ny joker i det klassiske kortsæt (`public/cards/classic/J1–J3.svg`): klassisk hofnar i rødt/sort/guld med
      "JOKER" på et bånd, spejlet top/bund, lodret "JOKER ★" i hjørnerne. Forlæg: skærmbillede
      `C:\Users\jhn\Documents\ShareX\Screenshots\chrome_2026-10-18_19-38-53.png` (kun 230×318 px – find en
      original i høj opløsning eller SVG, og tjek licensen; resten af sættet er CC0, se `LICENSE.txt`)
- [ ] Automatisk gem af bordet, hvis alle spillere har været væk længe

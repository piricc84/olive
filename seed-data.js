const isoDaysAgo = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0,10);
};

export const demoTraps = [
  { code:"OF-001", name:"Podere San Michele", lat:41.127, lng:16.872, type:"Cromotropica", bait:"Attrattivo ammoniacale", installDate: isoDaysAgo(12), status:"Attiva", tags:["coratina","uliveto"], notes:"File centrale, ombra pomeridiana" },
  { code:"OF-002", name:"Lamineto Nord", lat:41.121, lng:16.879, type:"Feromonica", bait:"Feromone + ammonio", installDate: isoDaysAgo(18), status:"Attiva", tags:["leccino","pianura"], notes:"Vicino al muretto a secco" },
  { code:"OF-003", name:"Valle del fico", lat:41.118, lng:16.865, type:"Cromotropica", bait:"Attrattivo proteico", installDate: isoDaysAgo(7), status:"Attiva", tags:["blend","bio"], notes:"Zona umida, controllare moscerini" },
  { code:"OF-004", name:"Campetto di prova", lat:41.131, lng:16.869, type:"Sensoristica", bait:"Lure digitale", installDate: isoDaysAgo(3), status:"In manutenzione", tags:["test","gateway"], notes:"Sensore in calibrazione" },
  { code:"OF-005", name:"Bordo Bosco", lat:41.124, lng:16.861, type:"Cromotropica", bait:"Attrattivo proteico", installDate: isoDaysAgo(28), status:"Attiva", tags:["bosco","rilievo"], notes:"Spostata di 5m verso sentiero" }
];

export const demoInspections = [
  { code:"OF-001", date: isoDaysAgo(9), adults:2, females:1, larvae:0, temperature:22.5, humidity:58, wind:6, notes:"Prime catture, nulla di critico", operator:"Pietro" },
  { code:"OF-001", date: isoDaysAgo(5), adults:4, females:2, larvae:0, temperature:24.0, humidity:62, wind:4, notes:"Trend in crescita, monitorare fra 3gg", operator:"Giulia" },
  { code:"OF-002", date: isoDaysAgo(10), adults:1, females:1, larvae:0, temperature:23.1, humidity:55, wind:7, notes:"Catture sporadiche", operator:"Marco" },
  { code:"OF-002", date: isoDaysAgo(3), adults:3, females:2, larvae:1, temperature:25.2, humidity:64, wind:5, notes:"Larve rilevate, valutare trattamento bio", operator:"Pietro" },
  { code:"OF-003", date: isoDaysAgo(6), adults:5, females:3, larvae:0, temperature:21.8, humidity:70, wind:3, notes:"Picco dopo pioggia", operator:"Giulia" },
  { code:"OF-003", date: isoDaysAgo(1), adults:6, females:4, larvae:1, temperature:27.1, humidity:63, wind:4, notes:"Attesa pioggia: fare follow-up", operator:"Marco" },
  { code:"OF-004", date: isoDaysAgo(2), adults:0, females:0, larvae:0, temperature:26.4, humidity:52, wind:8, notes:"Sensore offline, nessun dato", operator:"Tecnico" },
  { code:"OF-005", date: isoDaysAgo(11), adults:2, females:1, larvae:0, temperature:20.5, humidity:74, wind:5, notes:"Area ombreggiata, valori bassi", operator:"Pietro" },
  { code:"OF-005", date: isoDaysAgo(4), adults:3, females:2, larvae:0, temperature:23.9, humidity:68, wind:4, notes:"Stabile", operator:"Giulia" }
];

export const demoAlerts = [
  { name:"Soglia catture (adulti)", metric:"adults", threshold:5, active:true, scope:"any", note:"Notifica quando si superano 5 adulti" },
  { name:"Presenza larve", metric:"larvae", threshold:1, active:true, scope:"any", note:"Invia subito un promemoria" },
  { name:"Trappole vicine (200m)", metric:"nearby", threshold:200, active:true, scope:"any", note:"Ricorda di ispezionare quando sei in campo" }
];

export const demoMessages = [
  { date: new Date().toISOString(), channel:"Team", title:"Avvio campagna", body:"Campagna di monitoraggio attiva. Segui la checklist e sincronizza le foto.", tags:["aggiornamento","demo"] },
  { date: isoDaysAgo(3), channel:"Meteo", title:"Allerta vento", body:"Raffiche previste nel weekend: fissa meglio le cromotropiche esposte.", tags:["meteo","alert"] },
  { date: isoDaysAgo(8), channel:"Ricerca", title:"Nuovo attrattivo", body:"Disponibile campione di esca proteica a rilascio lento.", tags:["ricerca"] }
];

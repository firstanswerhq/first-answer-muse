// Spanish for the card: static translations of OUR template strings (headlines, answers, number labels,
// shopping list, steps, tips, retake tips), used when the customer writes in Spanish. Numbers are copied
// as they are; only words and unit names change. Muse Spark's own wording is never run through this.
// A string with no rule here comes back unchanged (English), never half-translated.

const NOUN = {
  chip: 'el impacto', crack: 'la grieta', foot: 'el pie', floor: 'el piso', driveway: 'la entrada', patio: 'el patio',
  walkway: 'el camino', sidewalk: 'la acera', slab: 'la losa', 'pool deck': 'el borde de la piscina', 'parking pad': 'el estacionamiento',
  fence: 'la cerca', 'house wall': 'la pared de la casa', 'garage door': 'la puerta del garaje', door: 'la puerta', 'front door': 'la puerta de entrada',
  quarter: 'la moneda de un cuarto de dólar', 'sheet of printer paper': 'la hoja de papel', 'gift or hotel card': 'la tarjeta',
  'double garage door': 'la puerta de garaje doble', 'single garage door': 'la puerta de garaje sencilla', coin: 'la moneda', 'sheet of paper': 'la hoja de papel',
};
const RULER = {
  quarter: 'moneda de un cuarto de dólar', penny: 'moneda de un centavo', nickel: 'moneda de cinco centavos', dime: 'moneda de diez centavos',
  'sheet of printer paper': 'hoja de papel carta', 'A4 sheet of paper': 'hoja de papel A4', 'gift or hotel card': 'tarjeta de regalo o de hotel',
  'dollar bill': 'billete de un dólar', 'license plate': 'placa del auto', 'double garage door': 'puerta de garaje doble',
  'single garage door': 'puerta de garaje sencilla', 'front door': 'puerta de entrada', door: 'puerta', 'garage door': 'puerta del garaje',
  '12 oz soda can': 'lata de refresco de 12 oz',
};
const noun = (n) => NOUN[String(n).replace(/^(?:the|a|an) /i, '').toLowerCase()] || `“${String(n).replace(/^(?:the|a|an) /i, '')}”`;
const bare = (n) => noun(n).replace(/^(?:el|la|los|las) /, '');

// Units next to numbers: "12 ft 2 in" -> "12 pies 2 pulg.", "420 sq ft" -> "420 pies cuadrados".
export function units(s) {
  return String(s)
    .replace(/(\d)\s*sq ft\b/g, '$1 pies cuadrados')
    .replace(/(\d)\s*sq in\b/g, '$1 pulgadas cuadradas')
    .replace(/(\d)\s*ft\b/g, '$1 pies')
    .replace(/(\d)\s*in\b\.?/g, '$1 pulg.')
    .replace(/(\d) pulg\.\)/g, '$1 pulg.)');
}
const pick = (p) => String(p).replace(/men’s/g, 'de hombre').replace(/women’s/g, 'de mujer').replace(/de wo/g, 'de mu');
const shoePick = (p) => String(p).replace(/(\d+(?:\.\d)?) women’s/g, '$1 de mujer').replace(/(\d+(?:\.\d)?) men’s/g, '$1 de hombre');
const gal = (n, w) => (/pail/.test(w) ? `${n} ${+n === 1 ? 'cubeta' : 'cubetas'} de cinco galones` : `${n} ${+n === 1 ? 'galón' : 'galones'}`);
const sealer = (k) => (k === 'asphalt' ? 'sellador para asfalto' : 'sellador para concreto');

const EXACT = {
  // headlines
  'Repair it': 'Se puede reparar',
  'Replace it': 'Hay que reemplazarlo',
  Fits: 'Cabe',
  'Fits, but tight': 'Cabe, pero justo',
  'Won’t fit': 'No cabe',
  'Too close to call from the photo': 'Muy justo para saberlo con la foto',
  // number labels
  Area: 'Área', Range: 'Rango', Size: 'Tamaño', 'Concrete sealer': 'Sellador para concreto', 'Asphalt sealer': 'Sellador para asfalto',
  'Chip size': 'Tamaño del impacto', 'Crack length': 'Largo de la grieta', 'Repair limit': 'Límite para reparar',
  'Foot length': 'Largo del pie', 'US men’s': 'EE. UU. hombre', 'US women’s': 'EE. UU. mujer', EU: 'EU',
  Narrowest: 'Lo más angosto', Typical: 'Normal', Needs: 'Necesita', Floor: 'Piso', 'Full tiles': 'Baldosas enteras', Buy: 'Comprar',
  Length: 'Largo', Width: 'Ancho', 'Long side': 'Lado largo', 'Short side': 'Lado corto', Accuracy: 'Precisión', Height: 'Altura', Distance: 'Distancia',
  // values
  '1 in (a quarter)': '1 pulg. (una moneda de un cuarto de dólar)',
  // shopping
  'Buy for the high end of the range; return unopened extras': 'Compra para el número más alto del rango; devuelve lo que no abras',
  'Windshield chip repair (many insurers cover it — check your policy)': 'Reparación del impacto en el parabrisas (muchas aseguradoras la cubren; revisa tu póliza)',
  'Windshield replacement': 'Cambio de parabrisas',
  'Gravel or pavers for a level pad, a little bigger than the unit': 'Grava o adoquines para una base nivelada, un poco más grande que la unidad',
  'Thinset mortar and a notched trowel (ask the store which notch fits your tile)': 'Mortero adhesivo (thinset) y una llana dentada (pregunta en la tienda qué muesca va con tu baldosa)',
  'Grout and 1/8 in spacers': 'Lechada (grout) y separadores de 1/8 pulg.',
  'Tile cutter or wet saw': 'Cortadora de baldosas o sierra al agua',
  // steps
  'Clean it first: pressure wash and let it dry 24 hours.': 'Primero límpiala: lávala a presión y déjala secar 24 horas.',
  'Check the forecast: no rain for 24–48 hours, above 50°F.': 'Revisa el pronóstico: sin lluvia por 24–48 horas y más de 50°F.',
  'Two thin coats beat one thick one; the second coat needs the same amount again.': 'Dos capas delgadas rinden más que una gruesa; la segunda capa lleva la misma cantidad otra vez.',
  'Put clear tape over it to keep dirt out.': 'Ponle cinta transparente encima para que no le entre tierra.',
  'Skip the car wash and blasting the defroster until it’s fixed.': 'Evita el autolavado y el desempañador a todo hasta que lo reparen.',
  'Get it repaired soon — chips spread with heat and bumps.': 'Repáralo pronto: los impactos se extienden con el calor y los baches.',
  'Get two quotes; ask if your insurance covers glass.': 'Pide dos cotizaciones; pregunta si tu seguro cubre vidrios.',
  'If your car has lane or collision cameras, ask about recalibration.': 'Si tu auto tiene cámaras de carril o de colisión, pregunta por la recalibración.',
  'Measure both feet and go by the bigger one.': 'Mide los dos pies y guíate por el más grande.',
  'Feet swell a little by evening; measure then if you can.': 'Los pies se hinchan un poco en la tarde; mide a esa hora si puedes.',
  'Between sizes, go half a size up.': 'Si quedas entre dos tallas, elige media talla más.',
  'Brands vary: some, like Nike, often run small, so try a half to a full size up.': 'Cada marca es distinta: algunas, como Nike, suelen quedar chicas, así que prueba de media a una talla más.',
  'Tape the narrowest spot once before you buy.': 'Mide con cinta la parte más angosta antes de comprar.',
  'Leave room to open the doors and walk around it.': 'Deja espacio para abrir las puertas y caminar alrededor.',
  'Check your city’s setback rule for how close to the fence it can sit.': 'Revisa la regla de tu ciudad sobre qué tan cerca de la cerca puede ir.',
  'Tape-measure one wall before the first cut.': 'Mide una pared con cinta antes del primer corte.',
  'Send the same shot again later to see if it changed.': 'Manda la misma foto más adelante para ver si cambió.',
  'two cuts each': 'dos cortes cada una',
};

// Tips and notes: known phrases replaced inside a longer tip (tips are joined with "; " or " ").
const PHRASES = [
  ['ruler shape looks off; is it partly hidden or bent?', 'la forma de la referencia se ve rara; ¿está tapada o doblada?'],
  ['coin is small in the photo; move closer', 'la moneda se ve pequeña en la foto; acércate'],
  ['photo taken at a steep angle; shoot from straight above', 'la foto está muy inclinada; tómala desde arriba, derecho'],
  ['for something this big, lay a sheet of paper or a gift card next to it instead of a coin', 'para algo tan grande, pon una hoja de papel o una tarjeta al lado en vez de una moneda'],
  ['part of it runs off the edge of the photo; step back so all of it is in the shot', 'una parte se sale de la foto; aléjate para que salga completo'],
  ['measured at the can\'s distance; best for things standing beside it', 'medido a la distancia de la lata; sirve mejor para cosas paradas a su lado'],
  ['an edge cut is under 2 in; consider a different tile size or orientation', 'un corte de borde queda de menos de 2 pulg.; considera otro tamaño de baldosa u otra orientación'],
  ['It’s within measuring error of the repair limit, so have a shop look before deciding.', 'Está dentro del margen de error del límite para reparar; que lo revise un taller antes de decidir.'],
  ['Measured from one photo — check one wall with a tape before cutting.', 'Medido con una sola foto: revisa una pared con cinta antes de cortar.'],
  ['For an exact number, take the photo with a door in it, standing on the same ground.', 'Para un número exacto, toma la foto con una puerta parada en el mismo piso.'],
  ['For an exact number, include a door standing on the same ground.', 'Para un número exacto, incluye una puerta parada en el mismo piso.'],
  ['Measuring needs the Meta models switched on for this server.', 'Para medir, este servidor necesita los modelos de Meta encendidos.'],
  ['Couldn’t reach Meta SAM 3.1 just now; tap Retry.', 'No pudimos contactar a Meta SAM 3.1; toca Reintentar.'],
];

// Whole-sentence rules, tried in order: [pattern, (match) => Spanish].
const RULES = [
  [/^About (.+) sq ft$/, (m) => `Unos ${m[1]} pies cuadrados`],
  [/^Size (.+)$/, (m) => `Talla ${shoePick(m[1])}`],
  [/^(.+) at the narrowest$/, (m) => `${units(m[1])} en lo más angosto`],
  [/^Buy (\d+) tiles$/, (m) => `Compra ${m[1]} baldosas`],
  [/^(\d+) (gallons?|five-gallon pails?) per coat$/, (m) => `${gal(m[1], m[2])} por capa`],
  [/^(\d+) tiles \(\+(\d+)%\)$/, (m) => `${m[1]} baldosas (+${m[2]}%)`],
  // driveway
  [/^Your ([\w ]+?) is about ([\d,]+) sq ft(?: \(about ([\d.]+) ft wide by ([\d.]+) ft long\))?, between ([\d,]+) and ([\d,]+) sq ft, measured against the (.+?)\. (.+)$/, (m) =>
    `Tu ${bare(m[1])} mide unos ${m[2]} pies cuadrados${m[3] ? ` (unos ${m[3]} pies de ancho por ${m[4]} pies de largo)` : ''}, entre ${m[5]} y ${m[6]} pies cuadrados, tomando como referencia la ${RULER[m[7]] || m[7]}. ${es(m[8])}`],
  [/^Buy (\d+) (gallons?|five-gallon pails?) of (concrete|asphalt) sealer per coat\.$/, (m) => `Compra ${gal(m[1], m[2])} de ${sealer(m[3])} por capa.`],
  [/^That’s (\d+) gallons of concrete sealer or (\d+) five-gallon pails of asphalt sealer per coat\.$/, (m) => `Son ${gal(m[1], 'gallons')} de sellador para concreto o ${gal(m[2], 'pails')} de sellador para asfalto por capa.`],
  [/^Concrete sealer: (\d+) gallons per coat \(at about (\d+) sq ft per gallon; labels say (.+)\)$/, (m) => `Sellador para concreto: ${gal(m[1], 'gallons')} por capa (unos ${m[2]} pies cuadrados por galón; las etiquetas dicen ${m[3]})`],
  [/^Asphalt sealer: (\d+) five-gallon pails per coat \(at about (\d+) sq ft per pail; labels say (.+)\)$/, (m) => `Sellador para asfalto: ${gal(m[1], 'pails')} por capa (unos ${m[2]} pies cuadrados por cubeta; las etiquetas dicen ${m[3]})`],
  [/^Rough number: for a tighter one, stand at the street end, straight on, phone at chest height, with the whole (.+?) and the (door|garage door) in the shot\.$/, (m) => `Número aproximado: para uno más preciso, párate en el lado de la calle, de frente, con el teléfono a la altura del pecho, y que salgan completos ${noun(m[1])} y ${noun(m[2])}.`],
  [/^Part of the (.+?) runs out of the photo; the edges were carried on, so check that end with a tape\.$/, (m) => `Una parte de ${noun(m[1])} se sale de la foto; seguimos los bordes, así que revisa ese extremo con cinta.`],
  // windshield
  [/^That (chip|crack) is (.+?) — (smaller than a quarter|under 6 in), so it can usually be repaired instead of replacing the glass\.$/, (m) =>
    `${m[1] === 'crack' ? 'Esa grieta' : 'Ese impacto'} mide ${units(m[2])}: ${m[3] === 'under 6 in' ? 'menos de 6 pulg.' : `más ${m[1] === 'crack' ? 'pequeña' : 'pequeño'} que una moneda de un cuarto de dólar`}, así que normalmente se puede reparar sin cambiar el vidrio.`],
  [/^That (chip|crack) is (.+?) — (bigger than a quarter|longer than 6 in), so most shops will say replace the windshield\.$/, (m) =>
    `${m[1] === 'crack' ? 'Esa grieta' : 'Ese impacto'} mide ${units(m[2])}: ${m[3] === 'longer than 6 in' ? 'más de 6 pulg.' : `más ${m[1] === 'crack' ? 'grande' : 'grande'} que una moneda de un cuarto de dólar`}, así que la mayoría de los talleres dirán que hay que reemplazar el parabrisas.`],
  // shoe
  [/^Your foot is (.+?) long \(([\d.]+) cm\)\. That’s a US (.+?), about EU (\d+)\.$/, (m) => `Tu pie mide ${units(m[1])} de largo (${m[2]} cm). Eso es talla EE. UU. ${shoePick(m[3])}, más o menos EU ${m[4]}.`],
  // shed
  [/^The gap is about (.+?), so a (.+?) wide one won’t fit\.$/, (m) => `El espacio mide unos ${units(m[1])}, así que uno de ${units(m[2])} de ancho no cabe.`],
  [/^The gap is about (.+?) \(somewhere from (.+?) to (.+?)\)\. That’s too close to call for (.+?); tape the narrowest spot before you buy\.$/, (m) => `El espacio mide unos ${units(m[1])} (entre ${units(m[2])} y ${units(m[3])}). Para ${units(m[4])} es muy justo para saberlo; mide con cinta la parte más angosta antes de comprar.`],
  [/^You have about (.+?) \(at least (.+?)\)\. A (.+?) wide one (fits|fits, but it’s tight)(?:, with about (.+?) on each side)?\.$/, (m) => `Tienes unos ${units(m[1])} (por lo menos ${units(m[2])}). Uno de ${units(m[3])} de ancho cabe${m[4] === 'fits' ? '' : ', pero justo'}${m[5] ? `, con unos ${units(m[5])} de cada lado` : ''}.`],
  [/^The gap is about (.+?), and (.+?) at the narrowest spot\.$/, (m) => `El espacio mide unos ${units(m[1])}, y ${units(m[2])} en la parte más angosta.`],
  [/^(.+) wide unit$/, (m) => `Unidad de ${units(m[1])} de ancho`],
  // tile
  [/^The floor is about (.+?) by (.+?) \(([\d,.]+) sq ft\)\. In (.+?) × (.+?) in tile that’s (\d+) tiles laid, plus (\d+)% extra for cuts and mistakes: buy (\d+) tiles\.$/, (m) =>
    `El piso mide unos ${units(m[1])} por ${units(m[2])} (${m[3]} pies cuadrados). Con baldosas de ${m[4]} × ${m[5]} pulg. son ${m[6]} baldosas colocadas, más ${m[7]}% extra para cortes y errores: compra ${m[8]} baldosas.`],
  [/^(\d+) tiles, (.+?) × (.+?) in \(same lot number on every box\)$/, (m) => `${m[1]} baldosas de ${m[2]} × ${m[3]} pulg. (mismo número de lote en todas las cajas)`],
  [/^Start at the center of the room: (.+) across, (.+) along\.$/, (m) => `Empieza en el centro del cuarto: ${tileAxis(m[1])} a lo ancho, ${tileAxis(m[2])} a lo largo.`],
  [/^(\d+) × (edge pieces along the two side walls|edge pieces along the two end walls|corner pieces): (.+)\.$/, (m) => `${m[1]} × ${{ 'edge pieces along the two side walls': 'piezas de borde junto a las dos paredes laterales', 'edge pieces along the two end walls': 'piezas de borde junto a las dos paredes de los extremos', 'corner pieces': 'piezas de esquina' }[m[2]]}: ${es(m[3])}.`],
  [/^cut each tile to (.+?) in (wide|long) \(trim (.+?) in\)$/, (m) => `corta cada baldosa a ${m[1]} pulg. de ${m[2] === 'wide' ? 'ancho' : 'largo'} (recorta ${m[3]} pulg.)`],
  // retake tips and refusals
  [/^Muse Spark says the coin looks like a (.+?), not a (.+?), so I didn’t measure\. If it is, send the photo again and say “it’s a (.+?)”\.$/, (m) => `Muse Spark dice que la moneda parece una ${RULER[m[1]] || m[1]}, no una ${RULER[m[2]] || m[2]}, así que no medí. Si es así, manda la foto otra vez y escribe “es un ${m[3]}”.`],
  [/^I didn’t measure this one: Muse Spark checked SAM’s outline of (the thing to measure|the ruler|the other side) and saw (.+?), not (.+?)\. .*$/, (m) => `No lo medí: Muse Spark revisó el contorno de SAM ${{ 'the thing to measure': 'de lo que hay que medir', 'the ruler': 'de la referencia', 'the other side': 'del otro lado' }[m[1]]} y vio “${m[2]}”, no ${noun(m[3])}. Vuelve a tomar la foto con ${noun(m[3])} completo, enfocado y cerca del centro.`],
  [/^I didn’t measure this one: Muse Spark couldn’t confirm SAM’s second outline in time\. Retake it with (.+?) whole, in focus and near the middle of the shot\.$/, (m) => `No lo medí: Muse Spark no alcanzó a confirmar el segundo contorno de SAM. Vuelve a tomar la foto con ${noun(m[1])} completo, enfocado y cerca del centro.`],
  [/^I couldn’t find the (.+?) in that photo\. (.+)$/, (m) => `No encontré ${noun(m[1])} en esa foto. Vuelve a intentarlo más cerca, con ${noun(m[1])} en el centro de la foto.`],
  [/^I found the (.+?) but not the (.+?)\. Step back so both are in the shot\.$/, (m) => `Encontré ${noun(m[1])} pero no ${noun(m[2])}. Aléjate un poco para que salgan los dos.`],
  [/^I need something of known size next to it: lay a (.+?) right beside it and send one more\.$/, (m) => `Necesito algo de tamaño conocido al lado: pon ${{ quarter: 'una moneda de un cuarto de dólar', 'gift card or a quarter': 'una tarjeta o una moneda de un cuarto de dólar', 'sheet of printer paper': 'una hoja de papel' }[m[1]] || m[1]} justo al lado y manda otra.`],
  [/^I need the (front door|garage door) in the shot as the ruler\..*$/, (m) => `Necesito ${noun(m[1])} en la foto como referencia. Párate en el lado de la calle para que ${noun(m[1])} quede al fondo, y manda otra.`],
  [/^I couldn’t measure the (.+?) from that angle\..*$/, (m) => `No pude medir ${noun(m[1])} desde ese ángulo. Párate en el lado de la calle, de frente, con ${noun(m[1])} completo y la puerta en la foto.`],
  [/^Sorry, measuring faces isn’t available here\..*$/, () => 'Lo siento, aquí no se miden caras. Sight mide trabajos para negocios locales: un piso de baldosas, un impacto en el parabrisas, la talla de zapato, si cabe un cobertizo o una entrada. Manda una de esas con una moneda, una hoja de papel o una puerta en la foto.'],
];

function tileAxis(s) {
  const m = String(s).match(/^(\d+) full tiles(?: \+ a (.+?) in cut at each (side|end) wall)?$/);
  if (!m) return s;
  return `${m[1]} baldosas enteras${m[2] ? ` + un corte de ${m[2]} pulg. en cada pared ${m[3] === 'side' ? 'lateral' : 'del extremo'}` : ''}`;
}

// One template string in Spanish (unchanged when there's no rule for it).
export function es(str) {
  if (str == null) return str;
  const s = String(str);
  if (EXACT[s]) return EXACT[s];
  for (const [re, fn] of RULES) { const m = s.match(re); if (m) return fn(m); }
  let out = s, hit = false;
  for (const [en, sp] of PHRASES) if (out.includes(en)) { out = out.split(en).join(sp); hit = true; }
  if (hit) return out;
  // A plain measured value ("0.56 in", "12 ft 2 in", "10.5 in · 26.7 cm", "370 – 470 sq ft", "16 × 7 ft").
  if (/\d/.test(s) && !/\p{L}/u.test(s.replace(/sq ft|sq in|\bft\b|\bin\b|\bcm\b|\bmm\b/g, ''))) return units(s);
  return s;
}

// "quarter (24.26 mm)" -> "moneda de un cuarto de dólar (24.26 mm)".
export function esRuler(spec) {
  const m = String(spec || '').match(/^(.+?) \((.+)\)$/);
  if (m && RULER[m[1]]) return `${RULER[m[1]]} (${units(m[2]).replace(/(\d) tall\b/, '$1 de alto').replace(/pulg\. tall/, 'pulg. de alto')})`;
  if (/^a typical phone height/.test(spec)) return 'la altura normal de un teléfono (no hay puerta en la foto)';
  return spec;
}

// Does a text read as Spanish? Common short words, counted; used before labeling Spark's text "en español".
const ES_WORDS = /(?<![\p{L}])(?:el|la|los|las|de|del|que|y|en|un|una|tu|su|para|por|con|es|son|mide|necesitas|compra|pies|pulgadas|galones|cubetas|baldosas|talla|antes|después|muy|más|pero|así|cada|primero)(?![\p{L}])/giu;
const EN_WORDS = /(?<![\p{L}])(?:the|and|of|to|your|is|are|for|with|it|that|this|buy|feet|inches|gallons|pails|tiles|size|before|after|very|more|but|so|each|first|about|then)(?![\p{L}])/giu;
export function detectLanguage(text) {
  const t = String(text || '');
  const esN = (t.match(ES_WORDS) || []).length + (/[áéíóúñ¿¡]/i.test(t) ? 2 : 0);
  const enN = (t.match(EN_WORDS) || []).length;
  if (esN >= 2 && esN > enN) return 'es';
  if (enN >= 1 && enN >= esN) return 'en';
  return esN > 0 ? 'es' : 'en';
}

// The whole card in Spanish (the business block stays as the owner gets it).
export function localizeResult(r) {
  // The owner gets the job in English: keep the English headline and ruler for the hand-off.
  const out = { ...r, lang: 'es', en: { headline: r.headline, measuredAgainst: r.measuredAgainst } };
  if (out.headline) out.headline = es(out.headline);
  if (out.answer && out.wording !== 'spark') out.answer = es(out.answer);
  if (out.answerTemplate) out.answerTemplate = es(out.answerTemplate);
  if (out.ask) out.ask = es(out.ask);
  if (out.measuredAgainst) out.measuredAgainst = esRuler(out.measuredAgainst);
  out.numbers = (out.numbers || []).map((n) => ({ label: es(n.label), value: es(n.value) }));
  out.shopping = (out.shopping || []).map(es);
  out.steps = (out.steps || []).map(es);
  if (out.overlay) out.overlay = { ...out.overlay,
    lines: (out.overlay.lines || []).map((l) => ({ ...l, label: l.label ? units(l.label) : l.label })),
    outlines: (out.overlay.outlines || []).map((o) => ({ ...o, label: o.role === 'rejected' ? o.label.replace(/^SAM’s first try/, 'Primer intento de SAM') : (NOUN[o.label] ? bare(o.label) : RULER[o.label] || o.label) })) };
  return out;
}

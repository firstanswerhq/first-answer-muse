// The demo business. Every price and every rule the agent quotes comes from here.
// The model never invents a number: it can only call the engine, and the engine reads this file.

export const business = {
  id: 'brightside',
  name: 'Brightside Exterior Care',
  owner: 'Dana',
  city: 'Nashville, TN',
  phone: '(615) 555-0142',
  hours: { open: 8, close: 17, days: [1, 2, 3, 4, 5, 6] }, // Mon-Sat, 8 AM to 5 PM
  timezone: 'America/Chicago',
  serviceArea: 'Davidson, Williamson and Sumner counties',
  services: {
    windows: {
      name: 'Window cleaning (outside)',
      unit: 'window',
      price: 9, // per window
      minimum: 149,
      hours: (n) => Math.max(1, Math.ceil(n / 15)), // about 15 windows an hour
      samConcept: 'window',
      note: 'Screens wiped and sills rinsed at no charge.',
    },
    driveway: {
      name: 'Driveway pressure washing',
      tiers: {
        small: { label: '1-car driveway', price: 139, hours: 1 },
        medium: { label: '2-car driveway', price: 189, hours: 2 },
        large: { label: '3-car or long driveway', price: 259, hours: 3 },
      },
      // When a photo is measured (garage door as the ruler), price by the square foot instead of the size tier.
      perSqft: 0.35,
      sqftMinimum: 139,
      sqftPerHour: 400,
      samConcept: 'driveway',
      note: 'Oil stains pre-treated; deep stains may fade but not vanish.',
    },
    gutters: {
      name: 'Gutter cleaning',
      tiers: {
        one: { label: 'one-story home', price: 129, hours: 1 },
        two: { label: 'two-story home', price: 189, hours: 2 },
        three: { label: 'three-story home', price: 269, hours: 3 },
      },
      samConcept: 'gutter',
      note: 'Downspouts flushed and debris bagged and hauled away.',
    },
  },
  // Prices for jobs measured from a Sight photo (First Answer Sight). A task without an entry here
  // is not on this business's price list: the lead still goes to the owner, who prices it.
  sight: {
    surface_area: { name: 'Driveway sealing (one coat)', perSqft: 0.3, minimum: 199, note: 'Pressure wash first: same square feet at the driveway washing price.' },
  },
  demoPrices: true,
  policies: [
    'No deposit needed to book. Pay when the job is done.',
    'Free reschedule up to 24 hours before the visit.',
    'Rain on the day: we call you that morning and move it to the next open day.',
  ],
};

// First Answer Sight: one demo business per chip, each with its own demo price list. Every Sight
// answer goes to the business that does that job; the owner board shows which one. All of these are
// made-up demo businesses with demo prices (labeled as such wherever a price is shown).
export const SIGHT_BUSINESSES = {
  floor_tile: {
    id: 'cornerstone-tile', name: 'Cornerstone Tile & Floor', owner: 'Luis', city: 'Nashville, TN', trade: 'tile installer',
    sight: { floor_tile: { kind: 'perSqft', name: 'Tile installation (labor, tile not included)', perSqft: 8.5, minimum: 600 } },
  },
  windshield_chip: {
    id: 'clearview-glass', name: 'ClearView Auto Glass', owner: 'Tasha', city: 'Nashville, TN', trade: 'auto glass shop',
    sight: { windshield_chip: { kind: 'chip', repair: { name: 'Windshield chip repair', price: 79 }, replace: { name: 'Windshield replacement', price: 389, recalibration: 225 } } },
  },
  shoe_size: {
    id: 'stride-shoes', name: 'Stride Shoe Co.', owner: 'Mei', city: 'Nashville, TN', trade: 'shoe store',
    sight: { shoe_size: { kind: 'shoe', name: 'Walking and running shoes', from: 89, fitting: 'free fitting' } },
  },
  gap_fit: {
    id: 'backyard-sheds', name: 'Backyard Shed Co.', owner: 'Ray', city: 'Nashville, TN', trade: 'shed dealer',
    sight: { gap_fit: { kind: 'shed', name: 'Shed delivery and install', install: 450, padPerSqft: 6 } },
  },
  surface_area: { ...business, trade: 'exterior cleaning and sealing company' },
};
export const ALL_BUSINESSES = [business, ...Object.values(SIGHT_BUSINESSES).filter((b) => b.id !== business.id)];
// The business a Sight answer goes to (tasks without their own business go to Brightside, unpriced).
export const sightBusiness = (task) => SIGHT_BUSINESSES[task] || business;
export const businessById = (id) => ALL_BUSINESSES.find((b) => b.id === id) || null;

export function serviceList() {
  return Object.entries(business.services).map(([id, s]) => {
    if (s.tiers) {
      return {
        id,
        name: s.name,
        options: Object.entries(s.tiers).map(([t, v]) => ({ tier: t, label: v.label, price: v.price })),
        note: s.note,
      };
    }
    return { id, name: s.name, pricePer: s.unit, price: s.price, minimum: s.minimum, note: s.note };
  });
}

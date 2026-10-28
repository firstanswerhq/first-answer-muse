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
  policies: [
    'No deposit needed to book. Pay when the job is done.',
    'Free reschedule up to 24 hours before the visit.',
    'Rain on the day: we call you that morning and move it to the next open day.',
  ],
};

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

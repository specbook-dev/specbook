import type { Pet } from '#api/petstore'
import { calm, type DemoState } from './store'

/** The same pets every time, so what a page shows and what a recording shows agree. */
const pets: Pet[] = [
  {
    id: 1,
    name: 'Rex',
    category: { id: 1, name: 'Dogs' },
    photoUrls: ['https://example.com/rex.png'],
    tags: [{ id: 1, name: 'friendly' }],
    status: 'available',
  },
  {
    id: 2,
    name: 'Mittens',
    category: { id: 2, name: 'Cats' },
    photoUrls: ['https://example.com/mittens.png'],
    tags: [{ id: 2, name: 'sleepy' }],
    status: 'available',
  },
  {
    id: 3,
    name: 'Goldie',
    category: { id: 3, name: 'Fish' },
    photoUrls: ['https://example.com/goldie.png'],
    status: 'pending',
  },
  {
    id: 4,
    name: 'Hoppy',
    category: { id: 4, name: 'Rabbits' },
    photoUrls: ['https://example.com/hoppy.png'],
    status: 'sold',
  },
  {
    id: 5,
    name: 'Pip',
    category: { id: 5, name: 'Birds' },
    photoUrls: ['https://example.com/pip.png'],
    tags: [{ id: 3, name: 'chatty' }],
    status: 'available',
  },
]

export const seed = (): DemoState => ({
  pets: structuredClone(pets),
  // one order to look at, so a request that fetches order 5001 works before anything was placed
  orders: [
    {
      id: 5001,
      petId: 1,
      quantity: 1,
      shipDate: '2026-01-01T00:00:00.000Z',
      status: 'placed',
      complete: false,
    },
  ],
  nextOrderId: 5002,
  chaos: calm(),
})

export interface Country {
  code: string
  name: string
  capital: string
  currency: string
  languages: { name: string }[]
}

export const countries: Country[] = [
  {
    code: 'FR',
    name: 'France',
    capital: 'Paris',
    currency: 'EUR',
    languages: [{ name: 'French' }],
  },
  {
    code: 'DE',
    name: 'Germany',
    capital: 'Berlin',
    currency: 'EUR',
    languages: [{ name: 'German' }],
  },
  {
    code: 'JP',
    name: 'Japan',
    capital: 'Tokyo',
    currency: 'JPY',
    languages: [{ name: 'Japanese' }],
  },
  {
    code: 'BR',
    name: 'Brazil',
    capital: 'Brasília',
    currency: 'BRL',
    languages: [{ name: 'Portuguese' }],
  },
  {
    code: 'IN',
    name: 'India',
    capital: 'New Delhi',
    currency: 'INR',
    languages: [{ name: 'Hindi' }, { name: 'English' }],
  },
  {
    code: 'US',
    name: 'United States',
    capital: 'Washington D.C.',
    currency: 'USD',
    languages: [{ name: 'English' }],
  },
  {
    code: 'KE',
    name: 'Kenya',
    capital: 'Nairobi',
    currency: 'KES',
    languages: [{ name: 'Swahili' }, { name: 'English' }],
  },
  {
    code: 'AU',
    name: 'Australia',
    capital: 'Canberra',
    currency: 'AUD',
    languages: [{ name: 'English' }],
  },
  {
    code: 'CA',
    name: 'Canada',
    capital: 'Ottawa',
    currency: 'CAD',
    languages: [{ name: 'English' }, { name: 'French' }],
  },
  { code: 'EG', name: 'Egypt', capital: 'Cairo', currency: 'EGP', languages: [{ name: 'Arabic' }] },
]

export const continents = [
  { code: 'AF', name: 'Africa' },
  { code: 'AN', name: 'Antarctica' },
  { code: 'AS', name: 'Asia' },
  { code: 'EU', name: 'Europe' },
  { code: 'NA', name: 'North America' },
  { code: 'OC', name: 'Oceania' },
  { code: 'SA', name: 'South America' },
]
